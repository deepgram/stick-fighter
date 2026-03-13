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
