import { describe, expect, it } from "vitest";
import { parseTargets } from "../src/cli/recon.ts";
import {
  captureStamp,
  exchangeLabel,
  initDataKeys,
  isDataRequest,
  rpcidsOf,
} from "../src/collector/recon.ts";

const BE =
  "https://classroom.google.com/u/1/_/ClassroomUi/data/batchexecute?rpcids=Zj93ge&source-path=%2Fa%2Fmissing%2Fall&rt=c";

describe("recon helpers", () => {
  it("keeps only XHR/fetch traffic", () => {
    expect(isDataRequest("xhr")).toBe(true);
    expect(isDataRequest("fetch")).toBe(true);
    expect(isDataRequest("script")).toBe(false);
  });

  it("reads rpcids and labels exchanges", () => {
    expect(rpcidsOf(BE)).toBe("Zj93ge");
    expect(rpcidsOf("not a url")).toBeUndefined();
    expect(exchangeLabel(BE)).toBe("Zj93ge");
    expect(exchangeLabel("https://play.google.com/log?format=json")).toBe("play.google.com_log");
  });

  it("finds AF_initDataCallback keys", () => {
    const html =
      "AF_initDataCallback({key: 'ds:0', hash: '1', data:[]});AF_initDataCallback({key: 'ds:3'";
    expect(initDataKeys(html)).toEqual(["ds:0", "ds:3"]);
    expect(initDataKeys("var AF_initDataCallback;")).toEqual([]);
  });

  it("makes filesystem-safe stamps", () => {
    expect(captureStamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03-04-05Z");
  });

  it("parses target files", () => {
    expect(
      parseTargets("# detail pages\n/c/x/a/y/details\n\n  https://classroom.google.com/ \n"),
    ).toEqual(["/c/x/a/y/details", "https://classroom.google.com/"]);
  });
});
