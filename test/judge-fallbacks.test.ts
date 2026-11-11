// Judgment model fallbacks: parsing the ordered chain, classifying which
// failures may advance to the next model, and walking the chain. Pure logic
// only - the host-side ping and judged call are injected.

import { describe, expect, test } from "bun:test"
import {
  FALLBACK_COOLDOWN_MS_DEFAULT,
  FALLBACK_COOLDOWN_MS_MAX,
  judgeFailureRetryable,
  parseFallbackCooldownMs,
  parseModelChain,
  runModelChain,
  type ModelVerdictLike,
} from "../src/logic"

const okVerdict = (): ModelVerdictLike => ({ ok: true })
const faultVerdict = (surface: string): ModelVerdictLike => ({
  ok: false,
  fault: { surface },
})

describe("parseModelChain", () => {
  test("puts the primary first and trims/dedupes fallbacks in order", () => {
    expect(parseModelChain([" b ", "c", "b"], "a")).toEqual({
      models: ["a", "b", "c"],
      warnings: [],
    })
  })

  test("an absent option keeps the primary alone", () => {
    expect(parseModelChain(undefined, "jev-1.13-free")).toEqual({
      models: ["jev-1.13-free"],
      warnings: [],
    })
  })

  test("dedupes a fallback that repeats the primary", () => {
    expect(parseModelChain(["a", "b"], "a").models).toEqual(["a", "b"])
  })

  test("a non-array option warns and keeps the primary", () => {
    const { models, warnings } = parseModelChain("jev-1.13", "jev-1.13-free")
    expect(models).toEqual(["jev-1.13-free"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("array")
  })

  test("non-string and empty entries warn and are ignored", () => {
    const { models, warnings } = parseModelChain([1, "", "  ", "b"], "a")
    expect(models).toEqual(["a", "b"])
    expect(warnings).toHaveLength(3)
    expect(warnings.every((warning) => warning.includes("non-empty strings"))).toBe(true)
  })

  test("an empty array is valid and keeps the primary", () => {
    expect(parseModelChain([], "a")).toEqual({ models: ["a"], warnings: [] })
  })
})

describe("parseFallbackCooldownMs", () => {
  test("defaults to one hour", () => {
    expect(parseFallbackCooldownMs(undefined)).toEqual({ ms: FALLBACK_COOLDOWN_MS_DEFAULT })
    expect(FALLBACK_COOLDOWN_MS_DEFAULT).toBe(3_600_000)
  })

  test("accepts zero and floors fractions", () => {
    expect(parseFallbackCooldownMs(0)).toEqual({ ms: 0 })
    expect(parseFallbackCooldownMs(1500.9)).toEqual({ ms: 1500 })
  })

  test("invalid values keep the default and warn", () => {
    for (const raw of [-1, "60000", Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = parseFallbackCooldownMs(raw)
      expect(parsed.ms).toBe(FALLBACK_COOLDOWN_MS_DEFAULT)
      expect(parsed.warning).toContain("non-negative number")
    }
  })

  test("clamps above one day", () => {
    const parsed = parseFallbackCooldownMs(FALLBACK_COOLDOWN_MS_MAX + 1)
    expect(parsed.ms).toBe(FALLBACK_COOLDOWN_MS_MAX)
    expect(parsed.warning).toContain("clamped")
  })
})

describe("judgeFailureRetryable", () => {
  test("rate limits, funds, outages, timeouts, and network errors advance", () => {
    expect(judgeFailureRetryable("jev: upstream 429 - rate limited")).toBe(true)
    expect(judgeFailureRetryable("jev: 402 - insufficient funds on the account")).toBe(true)
    expect(judgeFailureRetryable("jev: upstream 500 - internal error")).toBe(true)
    expect(judgeFailureRetryable("jev: upstream 502 - bad gateway")).toBe(true)
    expect(judgeFailureRetryable("jev: upstream failed - service unavailable")).toBe(true)
    expect(judgeFailureRetryable("fetch failed")).toBe(true)
    expect(judgeFailureRetryable("The operation was aborted due to timeout")).toBe(true)
  })

  test("credential, gate, and unknown-model failures stay fail-closed", () => {
    expect(judgeFailureRetryable("jev: 401 - credential rejected")).toBe(false)
    expect(judgeFailureRetryable("jev: 403 - endpoint refused the request")).toBe(false)
    expect(judgeFailureRetryable("jev: upstream 400 - model jev-9 is not available")).toBe(false)
    expect(judgeFailureRetryable("jev: upstream 404 - not found")).toBe(false)
  })
})

describe("runModelChain", () => {
  test("runs the primary when it is healthy and stops there", async () => {
    const attempted: string[] = []
    const outcome = await runModelChain(["primary", "fallback"], {
      verify: async () => okVerdict(),
      run: async (model) => {
        attempted.push(model)
        return `answered by ${model}`
      },
    })
    expect(outcome).toEqual({ value: "answered by primary", model: "primary" })
    expect(attempted).toEqual(["primary"])
  })

  test("skips a model whose deployment ping failed", async () => {
    const skipped: string[] = []
    const outcome = await runModelChain(["primary", "fallback"], {
      verify: async (model) => (model === "primary" ? faultVerdict("jev: model primary not available") : okVerdict()),
      run: async (model) => model,
      skip: (model) => skipped.push(model),
    })
    expect(outcome).toEqual({ value: "fallback", model: "fallback" })
    expect(skipped).toEqual(["primary"])
  })

  test("advances on a retryable judged failure and reports the fallback", async () => {
    const advances: string[] = []
    const outcome = await runModelChain(["primary", "fallback"], {
      verify: async () => okVerdict(),
      run: async (model) => {
        if (model === "primary") throw new Error("jev: upstream 429 - rate limited")
        return "ok"
      },
      retryable: judgeFailureRetryable,
      fallback: (from, to) => advances.push(`${from}->${to}`),
    })
    expect(outcome).toEqual({ value: "ok", model: "fallback" })
    expect(advances).toEqual(["primary->fallback"])
  })

  test("a credential failure surfaces immediately without advancing", async () => {
    const attempted: string[] = []
    await expect(
      runModelChain(["primary", "fallback"], {
        verify: async () => okVerdict(),
        run: async (model) => {
          attempted.push(model)
          throw new Error("jev: 401 - credential rejected")
        },
        retryable: judgeFailureRetryable,
      }),
    ).rejects.toThrow("401")
    expect(attempted).toEqual(["primary"])
  })

  test("a caller abort surfaces the failure without advancing", async () => {
    const attempted: string[] = []
    await expect(
      runModelChain(["primary", "fallback"], {
        verify: async () => okVerdict(),
        run: async (model) => {
          attempted.push(model)
          throw new Error("jev: upstream 429 - rate limited")
        },
        retryable: judgeFailureRetryable,
        aborted: () => true,
      }),
    ).rejects.toThrow("429")
    expect(attempted).toEqual(["primary"])
  })

  test("when every member fails retryably, the primary diagnostic is thrown", async () => {
    await expect(
      runModelChain(["primary", "fallback"], {
        verify: async () => okVerdict(),
        run: async (model) => {
          throw new Error(
            model === "primary"
              ? "jev: upstream 429 - primary rate limited"
              : "jev: upstream 500 - fallback down",
          )
        },
        retryable: judgeFailureRetryable,
      }),
    ).rejects.toThrow("primary rate limited")
  })

  test("an empty chain fails closed", async () => {
    await expect(
      runModelChain([], { verify: async () => okVerdict(), run: async () => "never" }),
    ).rejects.toThrow("no judgment model")
  })
})
