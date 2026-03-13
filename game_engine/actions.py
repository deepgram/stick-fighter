"""Actions enum and attack data — mirrors src/input.js Actions and src/fighter.js ATTACK_DATA."""

from dataclasses import dataclass
from enum import StrEnum


class Actions(StrEnum):
    # Directional (held)
    UP = "up"
    DOWN = "down"
    LEFT = "left"
    RIGHT = "right"

    # Attacks (edge-triggered)
    LIGHT_PUNCH = "lightPunch"
    MEDIUM_PUNCH = "mediumPunch"
    HEAVY_PUNCH = "heavyPunch"
    LIGHT_KICK = "lightKick"
    MEDIUM_KICK = "mediumKick"
    HEAVY_KICK = "heavyKick"

    # Compound actions (edge-triggered)
    JUMP = "jump"
    SOMERSAULT = "somersault"
    DASH_FORWARD = "dashForward"
    DASH_BACK = "dashBack"
    DASH_LEFT = "dashLeft"
    DASH_RIGHT = "dashRight"


@dataclass(frozen=True)
class AttackData:
    damage: int
    startup: int
    active: int
    recovery: int
    range: int
    hitstun: int
    blockstun: int
    type: str  # "high" | "mid" | "low"


ATTACK_DATA: dict[str, AttackData] = {
    Actions.LIGHT_PUNCH: AttackData(damage=3, startup=2, active=2, recovery=3, range=40, hitstun=8, blockstun=5, type="high"),
    Actions.MEDIUM_PUNCH: AttackData(damage=6, startup=3, active=2, recovery=5, range=50, hitstun=12, blockstun=7, type="high"),
    Actions.HEAVY_PUNCH: AttackData(damage=10, startup=5, active=3, recovery=8, range=55, hitstun=16, blockstun=10, type="high"),
    Actions.LIGHT_KICK: AttackData(damage=3, startup=2, active=2, recovery=4, range=50, hitstun=8, blockstun=5, type="low"),
    Actions.MEDIUM_KICK: AttackData(damage=7, startup=4, active=2, recovery=6, range=60, hitstun=12, blockstun=7, type="mid"),
    Actions.HEAVY_KICK: AttackData(damage=11, startup=6, active=3, recovery=10, range=65, hitstun=16, blockstun=10, type="low"),
}

ATTACK_ACTIONS: frozenset[str] = frozenset(ATTACK_DATA.keys())
