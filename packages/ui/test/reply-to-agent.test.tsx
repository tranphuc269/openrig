// @vitest-environment jsdom

// Reply to an agent in your own words — the web twin of the TUI's `reply`.
// The request must match what the TUI sends: verb answer|resolve, the decision text,
// the asker's actor session, and authority "primary-user".

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ReplyToAgent } from "../src/components/reply/ReplyToAgent.js";

function renderReply(props: Partial<React.ComponentProps<typeof ReplyToAgent>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReplyToAgent qitemId="q-1" actorSession="human@host" verb="answer" askerLabel="Architect" {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReplyToAgent", () => {
  it("sends the reply as the primary user and shows the daemon's outcome", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      actionId: "a1", verb: "answer", qitemId: "q-1", closedQitem: null, createdQitemId: "q-2",
      notifyAttempted: false, notifyResult: null, auditedAt: "t",
      answer: { outcome: "answered", unanswered: [], message: "Answered: it went back to the architect." },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderReply();

    const send = screen.getByTestId("reply-to-agent-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("reply-to-agent-text"), { target: { value: "  Use PostgreSQL.  " } });
    fireEvent.click(send);

    await waitFor(() => expect(screen.getByTestId("reply-to-agent-sent").textContent).toContain("went back to the architect"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mission-control/action");
    expect(JSON.parse(String(init.body))).toEqual({
      verb: "answer", qitemId: "q-1", actorSession: "human@host", decision: "Use PostgreSQL.", authority: "primary-user",
    });
  });

  it("resolves a parked task and forwards a remote host id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      actionId: "a1", verb: "resolve", qitemId: "q-1", closedQitem: null, createdQitemId: null,
      notifyAttempted: false, notifyResult: null, auditedAt: "t",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderReply({ verb: "resolve", hostId: "box-west" });

    fireEvent.change(screen.getByTestId("reply-to-agent-text"), { target: { value: "Ship on Friday" } });
    fireEvent.click(screen.getByTestId("reply-to-agent-send"));

    await waitFor(() => expect(screen.getByTestId("reply-to-agent-sent").textContent).toContain("unblocked"));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ verb: "resolve", decision: "Ship on Friday", hostId: "box-west", authority: "primary-user" });
  });

  it("keeps the text and shows the daemon's error when the reply is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "qitem_not_found", message: "qitem q-1 not found" }), { status: 404 })));
    renderReply();

    fireEvent.change(screen.getByTestId("reply-to-agent-text"), { target: { value: "Yes" } });
    fireEvent.click(screen.getByTestId("reply-to-agent-send"));

    await waitFor(() => expect(screen.getByTestId("reply-to-agent-error").textContent).toBe("qitem q-1 not found"));
    expect((screen.getByTestId("reply-to-agent-text") as HTMLTextAreaElement).value).toBe("Yes");
  });
});
