import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { privacyResponseHeaders } from "./legacy.middleware";

const invoke = (method: string, path: string) => {
  const headers = new Map<string, string>();
  let nextCalled = false;
  const req = { method, path } as Request;
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    vary(value: string) {
      headers.set("vary", value);
      return this;
    }
  } as unknown as Response;
  const next = (() => { nextCalled = true; }) as NextFunction;
  privacyResponseHeaders(req, res, next);
  return { headers, nextCalled };
};

for (const path of [
  "/api/users/example",
  "/api/posts/shared-id",
  "/api/calls/history",
  "/api/tournaments/public-code",
  "/api/ai-recruitment/recommendations"
]) {
  const result = invoke("GET", path);
  assert.equal(result.nextCalled, true);
  assert.equal(result.headers.get("cache-control"), "private, no-store, no-cache, must-revalidate");
  assert.equal(result.headers.get("pragma"), "no-cache");
  assert.equal(result.headers.get("expires"), "0");
  assert.equal(result.headers.get("vary"), "Authorization");
}

assert.equal(invoke("HEAD", "/api/users/example").headers.get("cache-control"), "private, no-store, no-cache, must-revalidate");
assert.equal(invoke("GET", "/api/health").headers.size, 0);
assert.equal(invoke("POST", "/api/users/privacy-settings").headers.size, 0);
assert.equal(invoke("GET", "/uploads/avatar.png").headers.size, 0);

console.log("privacy response header tests passed");
