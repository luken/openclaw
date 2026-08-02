import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  hasBuzzMentionSyntax,
  resolveBuzzMessageMentions,
  type BuzzMentionMember,
} from "./mentions.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const SECOND_ALICE_PUBLIC_KEY = "c".repeat(64);

function members(...values: BuzzMentionMember[]): BuzzMentionMember[] {
  return [{ publicKey: BOT_PUBLIC_KEY, displayName: "OpenClaw" }, ...values];
}

describe("Buzz outbound mentions", () => {
  it("resolves unique room-member names and preserves multi-word matching", () => {
    expect(
      resolveBuzzMessageMentions({
        text: "Thanks @Alice Example, please review.",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice Example" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
  });

  it("rejects unknown and ambiguous names without an explicit identity", () => {
    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @Missing",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow('Buzz mention "@missing" does not match a current room member');

    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @Alice",
        members: members(
          { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" },
          { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" },
        ),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow(nip19.npubEncode(ALICE_PUBLIC_KEY));
  });

  it("accepts explicit NIP-27 identities and ignores presentation-only ambiguous names", () => {
    const explicit = nip19.npubEncode(ALICE_PUBLIC_KEY);
    expect(
      resolveBuzzMessageMentions({
        text: `Hello @Alice (nostr:${explicit})`,
        members: members(
          { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" },
          { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" },
        ),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
  });

  it("rejects explicit identities outside the room and excludes the bot identity", () => {
    const outsider = "d".repeat(64);
    expect(() =>
      resolveBuzzMessageMentions({
        text: `nostr:${nip19.npubEncode(outsider)}`,
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow("is not a current room member");

    expect(
      resolveBuzzMessageMentions({
        text: `nostr:${nip19.npubEncode(BOT_PUBLIC_KEY)}`,
        members: members(),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([]);
  });

  it("does not resolve mention-like text inside Markdown code regions", () => {
    expect(
      resolveBuzzMessageMentions({
        text: "`@Alice`\n```\nnostr:npub1invalid\n```",
        members: undefined,
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([]);
    expect(hasBuzzMentionSyntax("mail user@example.com")).toBe(false);
  });
});
