import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvitePage } from "./InvitePage";

describe("InvitePage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a clear error for an invalid invite", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "This invite is invalid or no longer available" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));
    render(<InvitePage token="invalid" />);
    expect(await screen.findByText("Invite unavailable")).toBeInTheDocument();
    expect(screen.getByText("This invite is invalid or no longer available")).toBeInTheDocument();
  });
});
