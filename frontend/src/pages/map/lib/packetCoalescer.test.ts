import { describe, expect, it } from "vitest";

import { PacketCoalescer } from "./packetCoalescer";

const T0 = 1_000_000;

describe("PacketCoalescer", () => {
  it("first sighting is a new transmission with normalized ids", () => {
    const c = new PacketCoalescer();
    const arc = c.ingest({ id: 7, from: 1128082076, sender: "!aabbccdd", type: "text" }, T0);
    expect(arc).toMatchObject({ fromId: "433d2a9c", senderId: "aabbccdd", type: "text", isNewTransmission: true });
  });

  it("same id, different gateway → arc only (fan-in, not new)", () => {
    const c = new PacketCoalescer();
    c.ingest({ id: 7, from: 10, sender: "aaaaaaaa" }, T0);
    const arc = c.ingest({ id: 7, from: 10, sender: "bbbbbbbb" }, T0 + 500);
    expect(arc).toMatchObject({ senderId: "bbbbbbbb", isNewTransmission: false });
  });

  it("same id, same gateway → dropped duplicate", () => {
    const c = new PacketCoalescer();
    c.ingest({ id: 7, from: 10, sender: "aaaaaaaa" }, T0);
    expect(c.ingest({ id: 7, from: 10, sender: "aaaaaaaa" }, T0 + 100)).toBeNull();
  });

  it("rejects missing/broadcast endpoints", () => {
    const c = new PacketCoalescer();
    expect(c.ingest({ id: 1, from: 10 }, T0)).toBeNull(); // no sender
    expect(c.ingest({ id: 1, sender: "aaaaaaaa" }, T0)).toBeNull(); // no from
    expect(c.ingest({ id: 1, from: 4294967295, sender: "aaaaaaaa" }, T0)).toBeNull(); // broadcast from
    expect(c.ingest({ id: 1, from: 10, sender: "ffffffff" }, T0)).toBeNull(); // broadcast gateway
  });

  it("treats the same id as new again after the TTL lapses", () => {
    const c = new PacketCoalescer(1000);
    c.ingest({ id: 9, from: 10, sender: "aaaaaaaa" }, T0);
    const arc = c.ingest({ id: 9, from: 10, sender: "aaaaaaaa" }, T0 + 1001);
    expect(arc?.isNewTransmission).toBe(true);
  });

  it("evicts oldest beyond maxKeys", () => {
    const c = new PacketCoalescer(60_000, 2);
    c.ingest({ id: 1, from: 10, sender: "aaaaaaaa" }, T0);
    c.ingest({ id: 2, from: 10, sender: "aaaaaaaa" }, T0);
    c.ingest({ id: 3, from: 10, sender: "aaaaaaaa" }, T0); // evicts id:1
    expect(c.ingest({ id: 1, from: 10, sender: "aaaaaaaa" }, T0)?.isNewTransmission).toBe(true);
  });
});
