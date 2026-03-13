"""AI character definitions for single-player mode.

Each character has a unique personality that shapes their fighting style
via a personality prompt appended to the base LLM system prompt.
New characters can be added by creating a new entry in CHARACTERS — no
code changes to the game loop required.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Character:
    id: str
    name: str
    provider: str          # "anthropic" or "openai"
    icon: str              # emoji / ASCII icon for the selection screen
    description: str       # short personality blurb shown to the player
    personality_prompt: str # appended to the base system prompt


CHARACTERS: dict[str, Character] = {
    "haiku": Character(
        id="haiku",
        name="Haiku the Swift",
        provider="anthropic",
        icon="\u26a1",  # ⚡
        description="Relentless aggressor. Favors blinding speed, rapid dashes, "
                    "and combo flurries. Taunts about being too fast to hit.",
        personality_prompt=(
            "\n\nPERSONALITY: You are Haiku the Swift — a lightning-fast, "
            "hyper-aggressive fighter. Your style:\n"
            "- ALWAYS prioritize offense. Attack constantly, never idle.\n"
            "- Favor light and medium attacks (fast startup, low recovery).\n"
            "- Use dashes aggressively: dash forward into combos.\n"
            "- Chain rapid multi-hit sequences: e.g. "
            '["dash forward", "light punch", "light kick", "forward", "medium punch"]\n'
            "- Jump attacks are your bread and butter — close distance aerially.\n"
            "- Rarely block. If you must retreat, dash back then immediately re-engage.\n"
            "- Your plans should contain at least 3 attacks out of 5 moves.\n"
            "- Speed over power: light punch > heavy punch in most situations.\n"
        ),
    ),
    "gpt": Character(
        id="gpt",
        name="GPT the Tank",
        provider="openai",
        icon="\U0001f6e1\ufe0f",  # 🛡️
        description="Patient defender. Waits for openings, counter-attacks with "
                    "devastating heavies. Taunts about your impatience.",
        personality_prompt=(
            "\n\nPERSONALITY: You are GPT the Tank — a patient, defensive "
            "powerhouse. Your style:\n"
            "- ALWAYS prioritize defense. Block frequently, wait for openings.\n"
            "- Favor heavy attacks for maximum damage when you do strike.\n"
            "- Use 'back' (block) as your primary defensive tool — at least 1-2 "
            "blocks per plan.\n"
            "- Counter-attack pattern: block → then heavy punch or heavy kick.\n"
            "- Prefer ground-based fighting. Minimal jumping.\n"
            "- Crouch to dodge high attacks, then counter with crouch heavy punch.\n"
            "- Your plans should contain at least 1 'back' (block) move.\n"
            "- Patience over aggression: wait for the opponent to commit, then punish.\n"
            "- Use dash back to create space, then punish approaches with heavy kick.\n"
        ),
    ),
}

# Ordered list for UI display
CHARACTER_LIST: list[Character] = [CHARACTERS["haiku"], CHARACTERS["gpt"]]


def get_character(character_id: str) -> Character | None:
    """Look up a character by ID. Returns None if not found."""
    return CHARACTERS.get(character_id)
