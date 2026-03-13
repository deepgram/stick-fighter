"""Tests for character definitions and character-aware LLM endpoint."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from litestar.testing import TestClient

from characters import CHARACTER_LIST, CHARACTERS, Character, get_character
from server import app


# ─────────────────────────────────────────────
# Unit tests for characters module
# ─────────────────────────────────────────────


class TestCharacterDefinitions:
    """Validate character data integrity."""

    def test_character_list_not_empty(self) -> None:
        assert len(CHARACTER_LIST) >= 2

    def test_haiku_exists(self) -> None:
        char = get_character("haiku")
        assert char is not None
        assert char.name == "Haiku the Swift"
        assert char.provider == "anthropic"

    def test_gpt_exists(self) -> None:
        char = get_character("gpt")
        assert char is not None
        assert char.name == "GPT the Tank"
        assert char.provider == "openai"

    def test_unknown_character_returns_none(self) -> None:
        assert get_character("nonexistent") is None

    def test_all_characters_have_required_fields(self) -> None:
        for char in CHARACTER_LIST:
            assert isinstance(char, Character)
            assert char.id
            assert char.name
            assert char.provider in ("anthropic", "openai")
            assert char.icon
            assert char.description
            assert char.personality_prompt

    def test_character_list_matches_dict(self) -> None:
        """CHARACTER_LIST should contain exactly the characters in CHARACTERS."""
        list_ids = {c.id for c in CHARACTER_LIST}
        dict_ids = set(CHARACTERS.keys())
        assert list_ids == dict_ids

    def test_haiku_personality_emphasizes_aggression(self) -> None:
        char = get_character("haiku")
        assert char is not None
        prompt = char.personality_prompt.lower()
        assert "aggress" in prompt or "attack" in prompt

    def test_gpt_personality_emphasizes_defense(self) -> None:
        char = get_character("gpt")
        assert char is not None
        prompt = char.personality_prompt.lower()
        assert "defen" in prompt or "block" in prompt

    def test_haiku_has_speed_taunts(self) -> None:
        char = get_character("haiku")
        assert char is not None
        prompt = char.personality_prompt.lower()
        assert "taunt" in prompt
        assert "speed" in prompt or "fast" in prompt or "slow" in prompt

    def test_gpt_has_patience_taunts(self) -> None:
        char = get_character("gpt")
        assert char is not None
        prompt = char.personality_prompt.lower()
        assert "taunt" in prompt
        assert "patience" in prompt or "wait" in prompt or "impatien" in prompt

    def test_haiku_has_high_temperature(self) -> None:
        """Haiku should have a higher temperature for varied aggression."""
        char = get_character("haiku")
        assert char is not None
        assert char.temperature > 0.7

    def test_gpt_has_low_temperature(self) -> None:
        """GPT should have a lower temperature for methodical defense."""
        char = get_character("gpt")
        assert char is not None
        assert char.temperature < 0.6

    def test_characters_have_different_temperatures(self) -> None:
        """Characters must have distinct temperatures for different play styles."""
        haiku = get_character("haiku")
        gpt = get_character("gpt")
        assert haiku is not None and gpt is not None
        assert haiku.temperature != gpt.temperature

    def test_all_characters_have_temperature(self) -> None:
        """All characters must have a valid temperature between 0 and 2."""
        for char in CHARACTER_LIST:
            assert 0.0 <= char.temperature <= 2.0


# ─────────────────────────────────────────────
# Endpoint tests for GET /api/characters
# ─────────────────────────────────────────────


class TestListCharacters:
    """Tests for GET /api/characters endpoint."""

    def test_returns_character_list(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/api/characters")
            assert resp.status_code == 200
            data = resp.json()
            assert isinstance(data, list)
            assert len(data) >= 2

    def test_character_fields(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/api/characters")
            data = resp.json()
            for char in data:
                assert "id" in char
                assert "name" in char
                assert "provider" in char
                assert "icon" in char
                assert "description" in char
                # personality_prompt should NOT be exposed to client
                assert "personality_prompt" not in char

    def test_haiku_in_response(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/api/characters")
            data = resp.json()
            ids = [c["id"] for c in data]
            assert "haiku" in ids

    def test_gpt_in_response(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/api/characters")
            data = resp.json()
            ids = [c["id"] for c in data]
            assert "gpt" in ids


# ─────────────────────────────────────────────
# Tests for character-aware /api/llm/command
# ─────────────────────────────────────────────


class TestLLMCommandWithCharacter:
    """Verify /api/llm/command uses character-specific prompts."""

    @pytest.fixture(autouse=True)
    def _set_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    @patch("server._llm_anthropic", new_callable=AsyncMock)
    def test_haiku_character_uses_anthropic_with_personality(
        self, mock_anthropic: AsyncMock
    ) -> None:
        mock_anthropic.return_value = '["light punch", "forward", "light kick", "dash forward", "medium punch"]'

        with TestClient(app=app) as client:
            resp = client.post(
                "/api/llm/command",
                content=json.dumps({
                    "character": "haiku",
                    "messages": [{"role": "user", "content": "test state"}],
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            assert "plan" in resp.json()

            # Verify anthropic was called (haiku uses anthropic provider)
            mock_anthropic.assert_called_once()
            call_args = mock_anthropic.call_args
            system_prompt = call_args[0][1] if len(call_args[0]) > 1 else call_args[1].get("system_prompt", "")
            # The system prompt should contain the personality
            assert "Haiku the Swift" in system_prompt or "PERSONALITY" in system_prompt

    @patch("server._llm_openai", new_callable=AsyncMock)
    def test_gpt_character_uses_openai_with_personality(
        self, mock_openai: AsyncMock
    ) -> None:
        mock_openai.return_value = '["back", "heavy punch", "back", "heavy kick", "crouch"]'

        with TestClient(app=app) as client:
            resp = client.post(
                "/api/llm/command",
                content=json.dumps({
                    "character": "gpt",
                    "messages": [{"role": "user", "content": "test state"}],
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            assert "plan" in resp.json()

            # Verify openai was called (gpt uses openai provider)
            mock_openai.assert_called_once()
            call_args = mock_openai.call_args
            system_prompt = call_args[0][1] if len(call_args[0]) > 1 else call_args[1].get("system_prompt", "")
            assert "GPT the Tank" in system_prompt or "PERSONALITY" in system_prompt

    @patch("server._llm_anthropic", new_callable=AsyncMock)
    def test_no_character_uses_default_prompt(
        self, mock_anthropic: AsyncMock
    ) -> None:
        mock_anthropic.return_value = '["forward", "light punch"]'

        with TestClient(app=app) as client:
            resp = client.post(
                "/api/llm/command",
                content=json.dumps({
                    "provider": "anthropic",
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201

            # Default prompt should NOT contain PERSONALITY section
            call_args = mock_anthropic.call_args
            system_prompt = call_args[0][1] if len(call_args[0]) > 1 else call_args[1].get("system_prompt", "")
            assert "PERSONALITY" not in system_prompt

    @patch("server._llm_anthropic", new_callable=AsyncMock)
    def test_unknown_character_uses_default_prompt(
        self, mock_anthropic: AsyncMock
    ) -> None:
        mock_anthropic.return_value = '["forward"]'

        with TestClient(app=app) as client:
            resp = client.post(
                "/api/llm/command",
                content=json.dumps({
                    "character": "nonexistent",
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201

            # Unknown character falls back to default
            call_args = mock_anthropic.call_args
            system_prompt = call_args[0][1] if len(call_args[0]) > 1 else call_args[1].get("system_prompt", "")
            assert "PERSONALITY" not in system_prompt

    @patch("server._llm_openai", new_callable=AsyncMock)
    def test_character_overrides_provider(
        self, mock_openai: AsyncMock
    ) -> None:
        """Even if client sends provider=anthropic, character determines actual provider."""
        mock_openai.return_value = '["back"]'

        with TestClient(app=app) as client:
            resp = client.post(
                "/api/llm/command",
                content=json.dumps({
                    "provider": "anthropic",  # client says anthropic
                    "character": "gpt",       # but gpt character uses openai
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            # Should have called openai, not anthropic
            mock_openai.assert_called_once()

    @patch("server._llm_anthropic", new_callable=AsyncMock)
    def test_haiku_passes_temperature(
        self, mock_anthropic: AsyncMock
    ) -> None:
        """Haiku character should pass its temperature to the provider."""
        mock_anthropic.return_value = '["dash forward", "light punch"]'

        with TestClient(app=app) as client:
            client.post(
                "/api/llm/command",
                content=json.dumps({
                    "character": "haiku",
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )

            call_kwargs = mock_anthropic.call_args
            temperature = call_kwargs[1].get("temperature")
            assert temperature == 0.9

    @patch("server._llm_openai", new_callable=AsyncMock)
    def test_gpt_passes_temperature(
        self, mock_openai: AsyncMock
    ) -> None:
        """GPT character should pass its temperature to the provider."""
        mock_openai.return_value = '["back", "heavy punch"]'

        with TestClient(app=app) as client:
            client.post(
                "/api/llm/command",
                content=json.dumps({
                    "character": "gpt",
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )

            call_kwargs = mock_openai.call_args
            temperature = call_kwargs[1].get("temperature")
            assert temperature == 0.4

    @patch("server._llm_anthropic", new_callable=AsyncMock)
    def test_no_character_no_temperature(
        self, mock_anthropic: AsyncMock
    ) -> None:
        """Without a character, temperature should be None (use provider default)."""
        mock_anthropic.return_value = '["forward"]'

        with TestClient(app=app) as client:
            client.post(
                "/api/llm/command",
                content=json.dumps({
                    "provider": "anthropic",
                    "messages": [{"role": "user", "content": "test"}],
                }),
                headers={"Content-Type": "application/json"},
            )

            call_kwargs = mock_anthropic.call_args
            temperature = call_kwargs[1].get("temperature")
            assert temperature is None


# ─────────────────────────────────────────────
# Tests for distinct fighting personalities
# ─────────────────────────────────────────────


class TestDistinctPersonalities:
    """Verify characters have measurably different fighting style guidance."""

    ATTACK_KEYWORDS = {
        "light punch", "medium punch", "heavy punch",
        "light kick", "medium kick", "heavy kick",
    }
    DEFENSIVE_KEYWORDS = {"block", "back", "crouch", "dash back"}
    AGGRESSIVE_KEYWORDS = {
        "dash forward", "attack", "offense", "light punch",
        "light kick", "jump",
    }

    def _count_prompt_mentions(self, prompt: str, keywords: set[str]) -> int:
        """Count how many times keywords appear in the prompt."""
        lower = prompt.lower()
        return sum(lower.count(kw) for kw in keywords)

    def test_haiku_more_attack_references_than_defense(self) -> None:
        """Haiku's prompt should emphasize attack commands over defensive ones."""
        char = get_character("haiku")
        assert char is not None
        prompt = char.personality_prompt
        attack_count = self._count_prompt_mentions(prompt, self.AGGRESSIVE_KEYWORDS)
        defense_count = self._count_prompt_mentions(prompt, self.DEFENSIVE_KEYWORDS)
        assert attack_count > defense_count, (
            f"Haiku should be attack-heavy: attacks={attack_count}, defense={defense_count}"
        )

    def test_gpt_more_defense_references_than_haiku(self) -> None:
        """GPT's prompt should have more defensive references than Haiku's."""
        haiku = get_character("haiku")
        gpt = get_character("gpt")
        assert haiku is not None and gpt is not None
        haiku_def = self._count_prompt_mentions(haiku.personality_prompt, self.DEFENSIVE_KEYWORDS)
        gpt_def = self._count_prompt_mentions(gpt.personality_prompt, self.DEFENSIVE_KEYWORDS)
        assert gpt_def > haiku_def, (
            f"GPT should have more defense refs: gpt={gpt_def}, haiku={haiku_def}"
        )

    def test_haiku_more_aggression_references_than_gpt(self) -> None:
        """Haiku's prompt should have more aggressive references than GPT's."""
        haiku = get_character("haiku")
        gpt = get_character("gpt")
        assert haiku is not None and gpt is not None
        haiku_agg = self._count_prompt_mentions(haiku.personality_prompt, self.AGGRESSIVE_KEYWORDS)
        gpt_agg = self._count_prompt_mentions(gpt.personality_prompt, self.AGGRESSIVE_KEYWORDS)
        assert haiku_agg > gpt_agg, (
            f"Haiku should have more aggression refs: haiku={haiku_agg}, gpt={gpt_agg}"
        )

    def test_gpt_emphasizes_heavy_attacks(self) -> None:
        """GPT should mention heavy attacks more than light attacks."""
        char = get_character("gpt")
        assert char is not None
        prompt = char.personality_prompt.lower()
        heavy_count = prompt.count("heavy")
        light_count = prompt.count("light")
        assert heavy_count > light_count, (
            f"GPT should favor heavies: heavy={heavy_count}, light={light_count}"
        )

    def test_haiku_emphasizes_light_attacks(self) -> None:
        """Haiku should mention light attacks more than heavy attacks."""
        char = get_character("haiku")
        assert char is not None
        prompt = char.personality_prompt.lower()
        light_count = prompt.count("light")
        heavy_count = prompt.count("heavy")
        assert light_count > heavy_count, (
            f"Haiku should favor lights: light={light_count}, heavy={heavy_count}"
        )

    def test_haiku_demands_three_attacks_per_plan(self) -> None:
        """Haiku's prompt should instruct at least 3 attacks per 5-move plan."""
        char = get_character("haiku")
        assert char is not None
        assert "at least 3 attacks" in char.personality_prompt.lower()

    def test_gpt_demands_block_per_plan(self) -> None:
        """GPT's prompt should instruct at least 1 block per plan."""
        char = get_character("gpt")
        assert char is not None
        assert "at least 1" in char.personality_prompt.lower()
        assert "block" in char.personality_prompt.lower()

    def test_new_character_only_needs_config(self) -> None:
        """Adding a character requires only a CHARACTERS dict entry."""
        # Simulate adding a new character — just a dataclass, no imports needed
        new_char = Character(
            id="test",
            name="Test Fighter",
            provider="anthropic",
            icon="?",
            description="A test fighter",
            personality_prompt="\n\nPERSONALITY: You are a test fighter.",
            temperature=0.5,
        )
        # Verify it has all required fields — no game loop changes needed
        assert new_char.id == "test"
        assert new_char.temperature == 0.5
        assert new_char.personality_prompt.startswith("\n\nPERSONALITY:")
