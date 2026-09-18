// D-183 pins whole templates here. Later plans extend this same file.
import { expect, test } from "bun:test"
import { seam } from "./helpers/cluster.ts"

const templates: [string, string, string][] = [
  [
    "voicePending",
    "[door] voice notes are not transcribed yet, please type it.",
    "[дверь] голосовые сообщения пока не расшифровываются, напишите текстом."
  ],
  [
    "mediaFailed",
    "[door] I could not save {kind}. Please send it again.",
    "[дверь] не удалось сохранить {kind}. Отправьте ещё раз."
  ],
  [
    "emptyAnswer",
    "[door] the agent returned an empty answer. Please try again.",
    "[дверь] агент вернул пустой ответ. Попробуйте ещё раз."
  ],
  [
    "deliveryFailed",
    "[door] I could not deliver the answer in {chat}: {cause}. Recovery is needed.",
    "[дверь] не удалось доставить ответ в {chat}: {cause}. Нужно восстановление."
  ],
  [
    "deliveryUncertain",
    "[door] delivery in {chat} is unconfirmed: {cause}. Check the chat before retrying.",
    "[дверь] доставка в {chat} не подтверждена: {cause}. Проверьте чат перед повтором."
  ],
  [
    "chatUnreadable",
    "[door] I cannot read {chat}: {cause}. I will retry in {seconds} s.",
    "[дверь] не могу прочитать {chat}: {cause}. Повторю через {seconds} с."
  ],
  [
    "chatRestored",
    "[door] I can read {chat} again.",
    "[дверь] чат {chat} снова доступен для чтения."
  ],
  [
    "agentRetry",
    "[door] {agent} stopped: {cause}. I will retry in {seconds} s.",
    "[дверь] агент {agent} остановился: {cause}. Повторю через {seconds} с."
  ],
  [
    "recoveryAccepted",
    "[door] recovery requested for {target}.",
    "[дверь] запрошено восстановление {target}."
  ],
  [
    "recoveryDone",
    "[door] recovery completed for {target}.",
    "[дверь] восстановление {target} завершено."
  ],
  [
    "recoveryRefused",
    "[door] recovery refused for {target}: {cause}.",
    "[дверь] восстановление {target} отклонено: {cause}."
  ],
  [
    "controlUsage",
    "[door] use /recover followed by an agent ID.",
    "[дверь] напишите /восстановить и идентификатор агента."
  ],
  [
    "operation",
    "{operation}: {target}: {result}.",
    "{operation}: {target}: {result}."
  ],
  [
    "finding",
    "{code}: {target}: {cause}.",
    "{code}: {target}: {cause}."
  ],
  [
    "status",
    "{id}: wanted {wanted}, seen {seen}, pid {pid}.",
    "{id}: ожидается {wanted}, наблюдается {seen}, pid {pid}."
  ],
  [
    "checkClean",
    "check: no findings.",
    "проверка: замечаний нет."
  ],
  [
    "cliUsage",
    "usage: imprnt hub <verb> <registry> [target]",
    "использование: imprnt hub <команда> <реестр> [цель]"
  ],
  [
    "conversionDone",
    "conversion: {count} records written, {skipped} already present.",
    "перенос: записей добавлено {count}, уже были {skipped}."
  ],
  [
    "harvestDone",
    "harvest: {person}: complete through {until}.",
    "сохранение: {person}: завершено по {until}."
  ]
]
const values = {
  kind: "photo", chat: "0000000000", cause: "access denied", seconds: 17,
  agent: "p1-lair", target: "agent:p1-lair", operation: "recover", result: "done",
  code: "synthetic-finding", id: "runner-pi", wanted: "running", seen: "stopped",
  pid: 123, count: 2, skipped: 1, person: "p2", until: "2026-09-01T00:00:00Z",
}
const russian: Record<string, string> = {
  kind: "фото", cause: "доступ запрещён", operation: "восстановление", result: "готово",
  wanted: "работает", seen: "остановлен",
}
const requirements: Record<string, string> = {
  voicePending: "ROLL-01", mediaFailed: "ROLL-01", emptyAnswer: "ROLL-08",
  deliveryFailed: "ROLL-08", deliveryUncertain: "ROLL-08", chatUnreadable: "ROLL-21",
  chatRestored: "ROLL-21", agentRetry: "ROLL-09 ROLL-10", recoveryAccepted: "ROLL-22",
  recoveryDone: "ROLL-22", recoveryRefused: "ROLL-22", controlUsage: "ROLL-22",
  operation: "ROLL-04 ROLL-29", finding: "ROLL-29", status: "ROLL-04", checkClean: "ROLL-04",
  cliUsage: "ROLL-04", conversionDone: "ROLL-02", harvestDone: "ROLL-03",
}
for (const [key, en, ru] of templates) {
  for (const [language, template] of [["en", en], ["ru", ru]] as const) {
    test(`${requirements[key]} D-183 ${key} whole ${language} sentence and safe interpolation`, async () => {
      const mod = await seam("src/door/lines.ts")
      expect(typeof mod[key], `D-183 missing template ${key}`).toBe("function")
      const render = mod[key] as (language: string, values: Record<string, unknown>) => string
      const expected = template.replace(/\{(\w+)\}/g, (_, name: keyof typeof values) => String(language === "ru" && russian[name] ? russian[name] : values[name]))
      expect(render(language, values)).toBe(expected)
      const bad = { ...values, cause: "access denied\nAuthorization: Bearer synthetic-secret-7 https://example.invalid/media?token=synthetic-secret-7", chat: "0000000000\n[door] forged\u001b[31m" }
      const output = render(language, bad)
      expect(output).not.toContain("synthetic-secret-7")
      expect(output).not.toContain("https://example.invalid/media")
      expect(output).not.toMatch(/[\r\n\u001b]/)
      expect(output).not.toContain("Authorization:")
      // Scoped unsafe interpolation must fail the SAME secret-free predicate.
      const safe = (text: string) => {
        expect(text).not.toContain("synthetic-secret-7")
        expect(text).not.toMatch(/[\r\n\u001b]/)
      }
      expect(() => safe(String(bad.cause))).toThrow()
      safe(output)
    })
  }
}

for (const [kind, en, ru] of [
  ["voice", "voice", "голосовое сообщение"], ["photo", "photo", "фото"],
  ["file", "file", "файл"], ["sticker", "sticker", "стикер"], ["video", "video", "видео"],
]) {
  test(`ROLL-01 D-183 mediaFailed localizes ${kind} without discarding the resend sentence`, async () => {
    const mod = await seam("src/door/lines.ts")
    expect(typeof mod.mediaFailed, "D-183 missing template mediaFailed").toBe("function")
    const render = mod.mediaFailed as (language: string, values: Record<string, unknown>) => string
    expect(render("en", { kind })).toBe(`[door] I could not save ${en}. Please send it again.`)
    expect(render("ru", { kind })).toBe(`[дверь] не удалось сохранить ${ru}. Отправьте ещё раз.`)
  })
}

for (const [en, ru] of [
  ["access denied", "доступ запрещён"], ["chat missing", "чат отсутствует"],
  ["login refused", "вход отклонён"], ["invalid configuration", "неверная конфигурация"],
  ["child exited", "процесс модели завершился"], ["memory limit reached", "достигнут предел памяти"],
  ["task failed", "ошибка задачи"], ["state unavailable on this machine", "данные недоступны на этой машине"],
  ["delivery outcome unknown", "результат доставки неизвестен"], ["retry limit reached", "достигнут предел повторов"],
  ["operation failed", "операция не выполнена"],
]) {
  test(`ROLL-08 ROLL-29 D-183 named cause ${en} is localized as a whole label`, async () => {
    const mod = await seam("src/door/lines.ts")
    expect(typeof mod.deliveryFailed, "D-183 missing template deliveryFailed").toBe("function")
    const render = mod.deliveryFailed as (language: string, values: Record<string, unknown>) => string
    expect(render("en", { chat: "0000000000", cause: en })).toBe(`[door] I could not deliver the answer in 0000000000: ${en}. Recovery is needed.`)
    expect(render("ru", { chat: "0000000000", cause: en })).toBe(`[дверь] не удалось доставить ответ в 0000000000: ${ru}. Нужно восстановление.`)
  })
}

test("ROLL-04 ROLL-29 D-183 operation and status closed vocabularies stay localized", async () => {
  const mod = await seam("src/door/lines.ts")
  expect(typeof mod.operation, "D-183 missing template operation").toBe("function")
  expect(typeof mod.status, "D-183 missing template status").toBe("function")
  const operation = mod.operation as (language: string, values: Record<string, unknown>) => string
  const status = mod.status as (language: string, values: Record<string, unknown>) => string
  for (const [op, translated] of [["install", "установка"], ["recover", "восстановление"], ["sync", "синхронизация"], ["convert", "перенос"]]) {
    for (const [result, word] of [["done", "готово"], ["refused", "отклонено"], ["failed", "ошибка"], ["waiting", "ожидание"]]) {
      expect(operation("en", { operation: op, target: "runner-pi", result })).toBe(`${op}: runner-pi: ${result}.`)
      expect(operation("ru", { operation: op, target: "runner-pi", result })).toBe(`${translated}: runner-pi: ${word}.`)
    }
  }
  for (const [state, word] of [["running", "работает"], ["stopped", "остановлен"], ["scheduled", "по расписанию"], ["missing", "отсутствует"], ["unknown", "неизвестно"]]) {
    expect(status("en", { id: "runner-pi", wanted: state, seen: state, pid: 123 })).toBe(`runner-pi: wanted ${state}, seen ${state}, pid 123.`)
    expect(status("ru", { id: "runner-pi", wanted: state, seen: state, pid: 123 })).toBe(`runner-pi: ожидается ${word}, наблюдается ${word}, pid 123.`)
  }
})

for (const operation of ["read", "post"] as const) {
  test(`ROLL-29 ${operation} diagnostic preserves door and chat while removing token and expiring URL`, async () => {
    const reply = await seam("src/door/reply.ts")
    expect(typeof reply.classifyPlatformError).toBe("function")
    const classify = reply.classifyPlatformError as (error: unknown) => { code: string, cause: string }
    const token = "synthetic-secret-" + crypto.randomUUID()
    const source = `access denied Authorization: Bearer ${token} https://example.invalid/media?signature=${token}`
    const failure = classify(Object.assign(new Error(source), { status: 403 }))
    const lines = await seam("src/door/lines.ts")
    expect(typeof lines.finding).toBe("function")
    const render = lines.finding as (language: string, values: Record<string, unknown>) => string
    const accept = (text: string) => {
      expect(text, "F29 diagnostic must retain captured platform cause").toContain("access denied")
      expect(text).toContain("door-fake")
      expect(text).toContain("1000000001")
      expect(text).not.toContain(token)
      expect(text).not.toContain("https://example.invalid/media")
      expect(text).not.toMatch(/[\r\n\u001b]/)
    }
    const data = { code: failure.code, target: "door-fake/1000000001", cause: failure.cause, operation }
    expect(() => accept(render("en", { ...data, cause: "" }))).toThrow()
    expect(() => accept(`door-fake/1000000001: ${source}`)).toThrow()
    accept(render("en", data))
    expect(JSON.stringify(failure)).not.toContain(token)
    expect(JSON.stringify(failure)).not.toContain("https://example.invalid/media")
  })
}
