import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  setBootstrapPassword: vi.fn(),
}));

vi.mock("@/lib/sync", () => mocks);

import { FirstRunPasswordSetup } from "@/components/admin/FirstRunPasswordSetup";

function setup() {
  const onComplete = vi.fn();
  const onLogout = vi.fn();
  render(<FirstRunPasswordSetup onComplete={onComplete} onLogout={onLogout} />);
  return { onComplete, onLogout, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setBootstrapPassword.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("forced first-run password setup", () => {
  it("shows the required prompt and fields", () => {
    setup();

    expect(screen.getByRole("heading", { name: /set a new admin password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save password/i })).toBeInTheDocument();
  });

  it("explains that the initial password stops working and no hosting change is needed", () => {
    setup();

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/stops working immediately/i);
    expect(note).toHaveTextContent(/no\s+environment or hosting configuration needs to change/i);
  });

  it("never asks for the current password", () => {
    setup();

    // The caller already proved possession via the bootstrap login + Telegram tap.
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
    expect(screen.queryByLabelText(/username/i)).toBeNull();
  });

  it("rejects a too-short password without calling the API", async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText(/^new password$/i), "short");
    await user.type(screen.getByLabelText(/confirm password/i), "short");
    await user.click(screen.getByRole("button", { name: /save password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
    expect(mocks.setBootstrapPassword).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords without calling the API", async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText(/^new password$/i), "goodpassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "goodpassword2");
    await user.click(screen.getByRole("button", { name: /save password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
    expect(mocks.setBootstrapPassword).not.toHaveBeenCalled();
  });

  it("saves a valid password and reports completion", async () => {
    const { user, onComplete } = setup();

    await user.type(screen.getByLabelText(/^new password$/i), "brandnewpassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "brandnewpassword1");
    await user.click(screen.getByRole("button", { name: /save password/i }));

    await waitFor(() =>
      expect(mocks.setBootstrapPassword).toHaveBeenCalledWith("brandnewpassword1")
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("stays on the setup screen when the save fails", async () => {
    mocks.setBootstrapPassword.mockRejectedValue(new Error("Server refused"));
    const { user, onComplete } = setup();

    await user.type(screen.getByLabelText(/^new password$/i), "brandnewpassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "brandnewpassword1");
    await user.click(screen.getByRole("button", { name: /save password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/server refused/i);
    // Access must not be granted when setup did not succeed.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("offers signing out instead of proceeding", async () => {
    const { user, onLogout } = setup();

    await user.click(screen.getByRole("button", { name: /sign out instead/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
