import { describe, it, expect } from "vitest";
import {
  createOrderSchema,
  keyCheckSchema,
  loginSchema,
  addServerSchema,
} from "@/lib/validation";

describe("Validation Schemas", () => {
  describe("createOrderSchema", () => {
    it("should validate a valid order", () => {
      const result = createOrderSchema.safeParse({
        name: "John Doe",
        kpayRef: "123456",
        plan: "plan_a",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid KPay reference", () => {
      const result = createOrderSchema.safeParse({
        name: "John Doe",
        kpayRef: "12345", // only 5 digits
        plan: "plan_a",
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-numeric KPay reference", () => {
      const result = createOrderSchema.safeParse({
        name: "John Doe",
        kpayRef: "abcdef",
        plan: "plan_a",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid characters in name", () => {
      const result = createOrderSchema.safeParse({
        name: "John<script>alert('xss')</script>",
        kpayRef: "123456",
        plan: "plan_a",
      });
      expect(result.success).toBe(false);
    });

    it("should accept custom plan with valid data", () => {
      const result = createOrderSchema.safeParse({
        name: "John Doe",
        kpayRef: "123456",
        plan: "custom",
        customDataLimitGB: 50,
        customMonths: 3,
        customDevices: "2",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("keyCheckSchema", () => {
    it("should validate key check request", () => {
      const result = keyCheckSchema.safeParse({
        ssHost: "example.com",
        keyId: "123",
        password: "secret",
      });
      expect(result.success).toBe(true);
    });

    it("should require ssHost", () => {
      const result = keyCheckSchema.safeParse({
        keyId: "123",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("loginSchema", () => {
    it("should validate login credentials", () => {
      const result = loginSchema.safeParse({
        username: "admin",
        password: "password123",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty credentials", () => {
      const result = loginSchema.safeParse({
        username: "",
        password: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("addServerSchema", () => {
    it("should validate server with valid URL and cert", () => {
      const result = addServerSchema.safeParse({
        name: "My Server",
        apiUrl: "https://example.com/api",
        certSha256: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      });
      expect(result.success).toBe(true);
    });

    it("should accept cert without colons", () => {
      const result = addServerSchema.safeParse({
        name: "My Server",
        apiUrl: "https://example.com/api",
        certSha256: "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid URL", () => {
      const result = addServerSchema.safeParse({
        name: "My Server",
        apiUrl: "not-a-url",
        certSha256: "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899",
      });
      expect(result.success).toBe(false);
    });
  });
});
