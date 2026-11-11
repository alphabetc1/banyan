import { describe, expect, it } from "vitest";
import { applyEvent, draft, emptyRoomState, type Actor, type EventDraft, type RoomState } from "@banyan/shared";
import { systemPrompt } from "../src/prompts.ts";

function room(): RoomState {
  const state = emptyRoomState();
  const steps: [Actor, EventDraft][] = [
    [{ kind: "system" }, draft("room.created", { name: "r", repoUrl: "u", baseBranch: "main", rootGoalId: "root", rootGoalTitle: "Faster sglang", rootGoalDescription: "" })],
    [{ kind: "system" }, draft("member.joined", { memberId: "m", displayName: "Rhett", role: "owner" })],
    [{ kind: "system" }, draft("runner.registered", { runnerId: "r1", memberId: "m", hostname: "mac" })],
    [{ kind: "member", id: "m" }, draft("group.created", { groupId: "g", goalId: "root", name: "prefill team" })],
    [{ kind: "member", id: "m" }, draft("agent.created", { agentId: "w", groupId: "g", runnerId: "r1", name: "w", role: "worker", provider: "claude", model: "default", goalId: "root", instructions: "" })],
    [{ kind: "member", id: "m" }, draft("agent.created", { agentId: "s", groupId: null, runnerId: "r1", name: "s", role: "worker", provider: "claude", model: "default", goalId: "root", instructions: "profile decode" })],
  ];
  for (const [actor, d] of steps) applyEvent(state, { ...d, seq: state.lastSeq + 1, roomId: "room", ts: 1, actor });
  return state;
}

describe("system prompt", () => {
  it("names the group of a group member", () => {
    const state = room();
    const prompt = systemPrompt(state, state.agents.w!);
    expect(prompt).toContain("Your name: w. Your group: prefill team. Your goal: Faster sglang.");
    expect(prompt).not.toContain("You work on your own");
  });

  it("explains peers and review to a standalone agent", () => {
    const state = room();
    const prompt = systemPrompt(state, state.agents.s!);
    expect(prompt).toContain("You work on your own, not in a group.");
    expect(prompt).toContain("Your name: s. Your goal: Faster sglang.");
    expect(prompt).not.toContain("Your group:");
    expect(prompt).toContain("Instructions from the person who started you:\nprofile decode");
  });
});
