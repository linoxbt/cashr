import assert from "node:assert/strict";
import { test } from "node:test";

import { linkTarget } from "./links.ts";

test("pasted links resolve to app routes", () => {
  assert.equal(linkTarget("abcde12345"), "/e/abcde12345");
  assert.equal(linkTarget(" https://cashr-zec.netlify.app/e/abcde12345 "), "/e/abcde12345");
  assert.equal(linkTarget("https://host/manage/abcde12345#k=tok_EN-1"), "/manage/abcde12345#k=tok_EN-1");
  assert.equal(linkTarget("/door/abcde12345#k=t"), "/door/abcde12345#k=t");
  assert.equal(linkTarget("https://host/e/abcde12345#k=leak"), "/e/abcde12345");
  assert.equal(linkTarget("https://host/admin/abcde12345"), null);
  assert.equal(linkTarget("ABCDE12345"), null);
  assert.equal(linkTarget(""), null);
});
