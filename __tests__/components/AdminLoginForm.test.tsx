import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The sync module is mocked so these tests exercise the form's own state
 * machine, in particular that the Forgot Password flow never asks for a
 * username and that no request body carries one.
 */
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  pollLoginStatus: vi.fn(),
  cancelLogin: vi.fn(),
  forgotPassword: vi.fn(),
  verifyResetCode: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock("@/lib/sync", () => mocks);

import { AdminLoginForm } from "@/components/AdminLoginForm";

function setup() {
  const onUnlock = vi.fn();
  const onBack = vi.fn();
  render(<AdminLoginForm onUnlock={onUnlock} onBack={onBack} />);
  return { onUnlock, onBack, user: userEvent.setup() };
}

const RESET_ID = "a".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forgotPassword.mockResolvedValue({
    status: "code_sent",
    resetId: RESET_ID,
    resendCooldownSeconds: 60,
  });
  mocks.verifyResetCode.mockResolvedValue(undefined);
  mocks.resetPassword.mockResolvedValue(undefined);
  mocks.pollLoginStatus.mockResolvedValue("pending");
});

afterEach(() => cleanup());

describe("normal login screen", () => {
  it("shows username, password and a Forgot Password action", () => {
    setup();

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /forgot password/i })).toBeInTheDocument();
  });

  it("does not submit when fields are empty", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /^login$/i }));

    expect(mocks.login).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/enter your username and password/i);
  });

  it("moves to the Telegram waiting state and never unlocks on its own", async () => {
    mocks.login.mockResolvedValue({
      attemptId: "b".repeat(32),
      browserSecret: "c".repeat(64),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });

    const { user, onUnlock } = setup();

    await user.type(screen.getByLabelText(/username/i), "some-admin");
    await user.type(screen.getByLabelText(/^password$/i), "some-password");
    await user.click(screen.getByRole("button", { name: /^login$/i }));

    expect(await screen.findByText(/waiting for telegram approval/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    // Credentials alone must never unlock the dashboard.
    expect(onUnlock).not.toHaveBeenCalled();
  });
});

describe("forgot password flow", () => {
  it("starts without asking for a username and sends no username", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(await screen.findByText(/enter reset code/i)).toBeInTheDocument();

    // The server is asked to resolve the username itself.
    expect(mocks.forgotPassword).toHaveBeenCalledTimes(1);
    const arg = mocks.forgotPassword.mock.calls[0][0];
    expect(arg == null).toBe(true);
    expect(JSON.stringify(mocks.forgotPassword.mock.calls[0])).not.toContain("username");
  });

  it("renders NO username input anywhere in the code step", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await screen.findByText(/enter reset code/i);

    expect(screen.queryByLabelText(/username/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/username/i)).toBeNull();

    // The only text-ish field is the 6-digit code.
    const codeInput = screen.getByLabelText(/reset code/i);
    expect(codeInput).toHaveAttribute("maxLength", "6");
    expect(codeInput).toHaveAttribute("inputMode", "numeric");
  });

  it("tells the admin their username will arrive over Telegram", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(
      await screen.findByText(/check telegram for your username and 6-digit reset code/i)
    ).toBeInTheDocument();
  });

  it("only accepts six numeric digits", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    const codeInput = await screen.findByLabelText(/reset code/i);

    await user.type(codeInput, "12ab34cd56");
    expect(codeInput).toHaveValue("123456");
  });

  it("verifies the code then reaches the new-password step with no username field", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await user.type(await screen.findByLabelText(/reset code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify code/i }));

    await waitFor(() => expect(mocks.verifyResetCode).toHaveBeenCalledWith(RESET_ID, "123456"));

    expect(await screen.findByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).toBeNull();
  });

  it("rejects mismatched new passwords without calling the API", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await user.type(await screen.findByLabelText(/reset code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify code/i }));

    await user.type(await screen.findByLabelText(/^new password$/i), "goodpassword1");
    await user.type(screen.getByLabelText(/confirm new password/i), "differentpass1");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
    expect(mocks.resetPassword).not.toHaveBeenCalled();
  });

  it("rejects a too-short new password without calling the API", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await user.type(await screen.findByLabelText(/reset code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify code/i }));

    await user.type(await screen.findByLabelText(/^new password$/i), "short");
    await user.type(screen.getByLabelText(/confirm new password/i), "short");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
    expect(mocks.resetPassword).not.toHaveBeenCalled();
  });

  it("shows success and never logs the admin in", async () => {
    const { user, onUnlock } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await user.type(await screen.findByLabelText(/reset code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify code/i }));

    await user.type(await screen.findByLabelText(/^new password$/i), "brandnewpass1");
    await user.type(screen.getByLabelText(/confirm new password/i), "brandnewpass1");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByText(/password reset successfully/i)).toBeInTheDocument();
    // Reset must not authenticate the admin.
    expect(onUnlock).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("returns to the login form afterwards", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await user.type(await screen.findByLabelText(/reset code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify code/i }));

    await user.type(await screen.findByLabelText(/^new password$/i), "brandnewpass1");
    await user.type(screen.getByLabelText(/confirm new password/i), "brandnewpass1");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await user.click(await screen.findByRole("button", { name: /back to login/i }));

    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
  });
});

describe("resend", () => {
  it("is disabled while the cooldown is running", async () => {
    // Default mock reports a 60s cooldown.
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await screen.findByLabelText(/reset code/i);

    const resend = screen.getByRole("button", { name: /resend code in \d+s/i });
    expect(resend).toBeDisabled();
  });

  it("passes the previous resetId and never a username once the cooldown is clear", async () => {
    mocks.forgotPassword.mockResolvedValue({
      status: "code_sent",
      resetId: RESET_ID,
      resendCooldownSeconds: 0,
    });

    const { user } = setup();

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    await screen.findByLabelText(/reset code/i);

    const resend = await screen.findByRole("button", { name: /^resend code$/i });
    expect(resend).toBeEnabled();

    await user.click(resend);

    await waitFor(() => expect(mocks.forgotPassword).toHaveBeenCalledTimes(2));
    // Resend rotates the existing request; it still sends no username.
    expect(mocks.forgotPassword).toHaveBeenLastCalledWith(RESET_ID);
    expect(JSON.stringify(mocks.forgotPassword.mock.calls)).not.toContain("username");
  });

  it("surfaces a cooldown response from the server", async () => {
    mocks.forgotPassword.mockResolvedValue({
      status: "cooldown",
      retryAfterSeconds: 42,
      resendCooldownSeconds: 60,
    });

    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/42s/);
  });
});
