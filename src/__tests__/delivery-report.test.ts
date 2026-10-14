import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRelay } from "../stream-relay.js";
import type { DeliveryReport } from "../cards/contracts.js";

const state = vi.hoisted(() => ({ uuid: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++state.uuid).padStart(12, "0")}`,
}));

interface RequestBody {
  channel_id: string;
  channel_type: number;
  payload: { type: number; content: string };
  client_msg_no: string;
}
type Reply = (body: RequestBody, index: number) => Response;
let requests: string[];
let reply: Reply;
const parts = ["A".repeat(3500), "B".repeat(3500), "C".repeat(27)];

function confirmed(body: RequestBody, index: number): Response {
  return Response.json({ message_id: `message-${index + 1}`, client_msg_no: body.client_msg_no });
}
async function* chunks(text: string): AsyncIterable<string> { yield text; }
async function deliver(text: string): Promise<DeliveryReport> {
  return new StreamRelay().deliver("fixture-direct", 1, chunks(text), "https://fixture.invalid", "synthetic-placeholder");
}
function assertAttempts(expected: string[]): void {
  expect(requests).toEqual(expected.map((content, index) => JSON.stringify({
    channel_id: "fixture-direct", channel_type: 1, payload: { type: 1, content },
    client_msg_no: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  })));
  expect(vi.getTimerCount()).toBe(0);
}
function assertReport(report: DeliveryReport, expected: number, ids: string[]): void {
  expect(report).toEqual({ expected, acked: ids.length, failed: expected - ids.length, messageIds: ids, emptyNotice: false });
  expect(report.expected).toBe(report.acked + report.failed);
  expect(new Set(report.messageIds).size).toBe(report.messageIds.length);
}

beforeEach(() => {
  state.uuid = 0; requests = []; reply = confirmed;
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    if (new URL(input).pathname === "/v1/bot/typing") return Response.json({});
    const raw = String(init.body);
    const index = requests.length; requests.push(raw);
    return reply(JSON.parse(raw) as RequestBody, index);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("correlated delivery report", () => {
  it.each(["Answer Ω😀.", parts.join("")])("acknowledges every usable correlated identity", async text => {
    const expectedParts = text === parts.join("") ? parts : [text];
    assertReport(await deliver(text), expectedParts.length, expectedParts.map((_, i) => `message-${i + 1}`));
    assertAttempts(expectedParts);
  });
  it.each([{ failed: [0] }, { failed: [1] }, { failed: [2] }, { failed: [0, 1, 2] }])("continues once after failed segment(s) $failed", async ({ failed }) => {
    reply = (body, i) => failed.includes(i) ? new Response("synthetic outage", { status: 503 }) : confirmed(body, i);
    assertReport(await deliver(parts.join("")), 3, parts.flatMap((_, i) => failed.includes(i) ? [] : [`message-${i + 1}`]));
    assertAttempts(parts);
  });
  const invalid: [string, (body: RequestBody) => unknown][] = [
    ["missing", b => ({ client_msg_no: b.client_msg_no })],
    ["empty", b => ({ message_id: "", client_msg_no: b.client_msg_no })],
    ["whitespace", b => ({ message_id: "   ", client_msg_no: b.client_msg_no })],
    ["null", b => ({ message_id: null, client_msg_no: b.client_msg_no })],
    ["object", b => ({ message_id: {}, client_msg_no: b.client_msg_no })],
    ["number", b => ({ message_id: 7, client_msg_no: b.client_msg_no })],
    ["unsafe number", b => ({ message_id: 1.25e20, client_msg_no: b.client_msg_no })],
    ["out-of-range int64 string", b => ({ message_id: "9223372036854775808", client_msg_no: b.client_msg_no })],
    ["zero int64 string", b => ({ message_id: "0", client_msg_no: b.client_msg_no })],
    ["negative int64 string", b => ({ message_id: "-1234567890123456789", client_msg_no: b.client_msg_no })],
    ["boolean", b => ({ message_id: true, client_msg_no: b.client_msg_no })],
    ["mismatch", () => ({ message_id: "message", client_msg_no: "other-request" })],
    ["missing correlation", () => ({ message_id: "message" })],
    ["null result", () => null],
    ["array result", () => []],
  ];
  it.each(invalid)("counts %s as unconfirmed", async (_, value) => {
    reply = b => Response.json(value(b));
    assertReport(await deliver(parts.join("")), 3, []);
    assertAttempts(parts);
  });
  it.each(["", "{invalid JSON"])("continues after empty or malformed response %j", async raw => {
    reply = (b, i) => i === 1 ? new Response(raw) : confirmed(b, i);
    assertReport(await deliver(parts.join("")), 3, ["message-1", "message-3"]);
    assertAttempts(parts);
  });
  it.each(["1234567890123456789", "9223372036854775807"])("preserves numeric int64 %s exactly", async id => {
    reply = b => new Response(`{"message_id":${id},"client_msg_no":"${b.client_msg_no}"}`);
    assertReport(await deliver("Answer."), 1, [id]);
    assertAttempts(["Answer."]);
  });
  it("preserves opaque string identities without rewriting them", async () => {
    reply = b => Response.json({ message_id: " opaque-message Ω ", client_msg_no: b.client_msg_no });
    assertReport(await deliver("Answer."), 1, [" opaque-message Ω "]);
    assertAttempts(["Answer."]);
  });
  it("does not acknowledge duplicate transport identities for later segments", async () => {
    reply = b => Response.json({ message_id: "same-message", client_msg_no: b.client_msg_no });
    assertReport(await deliver(parts.join("")), 3, ["same-message"]);
    assertAttempts(parts);
  });
  it("keeps legitimate empty output separate from an acknowledged empty notice", async () => {
    assertReport(await deliver(""), 0, []);
    assertAttempts([]);
  });
  it("flushes partial text despite concurrent delivery failure and rethrows the original object", async () => {
    const error = new Error("Synthetic iterator failure");
    reply = (b, i) => i === 1 ? new Response("synthetic outage", { status: 503 }) : confirmed(b, i);
    const stream = (async function* () { yield parts.join(""); throw error; })();
    await expect(new StreamRelay().deliver("fixture-direct", 1, stream, "https://fixture.invalid", "synthetic-placeholder")).rejects.toBe(error);
    assertAttempts(parts);
  });
});
