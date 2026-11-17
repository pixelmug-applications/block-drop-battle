"""Hardware-free checks for the 32x16 battle display."""

import runpy
import sys
import time
import types
import unittest
from pathlib import Path


class FakePyxel(types.ModuleType):
    def __init__(self):
        super().__init__("micropyxel")
        self.pixels = {}
        self.texts = []

    def cls(self, color):
        self.pixels = {}
        self.texts = []

    def pset(self, x, y, color):
        assert 0 <= x < 32 and 0 <= y < 16, (x, y)
        self.pixels[(x, y)] = color

    def text(self, x, y, value, color):
        self.texts.append((x, y, value, color))


def load_app(pyxel):
    stubs = {
        "audio_service": types.SimpleNamespace(audio=None),
        "micropyxel": pyxel,
        "mpy_message": types.SimpleNamespace(),
        "mpyvm_event": types.SimpleNamespace(),
        "maopaoBleApp": types.SimpleNamespace(BleAppService=object),
        "pyxel_prompt_sound": types.SimpleNamespace(PromptSoundPlayer=object),
    }
    originals = {name: sys.modules.get(name) for name in stubs}
    try:
        sys.modules.update(stubs)
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / "mpy" / "__main__.py"), run_name="test")
    finally:
        for name, original in originals.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
    return namespace


class ScoreboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pyxel = FakePyxel()
        cls.namespace = load_app(cls.pyxel)
        cls.app_type = cls.namespace["BlockDropBattleApp"]
        cls.original_ticks_ms = getattr(time, "ticks_ms", None)
        cls.original_ticks_diff = getattr(time, "ticks_diff", None)
        time.ticks_ms = lambda: 0
        time.ticks_diff = lambda a, b: a - b

    @classmethod
    def tearDownClass(cls):
        for name, original in (("ticks_ms", cls.original_ticks_ms), ("ticks_diff", cls.original_ticks_diff)):
            if original is None:
                delattr(time, name)
            else:
                setattr(time, name, original)

    def app(self):
        app = self.app_type.__new__(self.app_type)
        app.state = self.namespace["STATE_PLAYING"]
        app.board = [[0] * 10 for _ in range(16)]
        app.board[15][0] = self.namespace["COL_GREEN"]
        app.piece = None
        app.next_kind = 3  # O piece
        app.clearing_rows = []
        app.lines = 3
        app.opponent_lines = 5
        app.opponent_playing = True
        app.opponent_finished = False
        return app

    def test_playing_layout_and_colors(self):
        app = self.app()
        app.draw(None)
        pixels = self.pyxel.pixels
        self.assertTrue(any(x < 10 and 5 <= y <= 10 for x, y in pixels))
        self.assertEqual(pixels[(11, 15)], self.namespace["COL_GREEN"])
        self.assertTrue(any(x >= 22 and y < 5 and color == self.namespace["COL_YELLOW"] for (x, y), color in pixels.items()))
        self.assertTrue(any(x >= 22 and y >= 11 and color == self.namespace["COL_RED"] for (x, y), color in pixels.items()))
        self.assertEqual(pixels[(25, 8)], self.namespace["COL_GREEN"])
        self.assertEqual(pixels[(28, 8)], self.namespace["COL_GREEN"])

    def test_finished_board_stays_visible_while_own_score_blinks(self):
        app = self.app()
        app.state = self.namespace["STATE_FINISHED"]
        time.ticks_ms = lambda: 500
        app.draw(None)
        pixels = self.pyxel.pixels
        self.assertEqual(pixels[(11, 15)], self.namespace["COL_GREEN"])
        self.assertEqual(pixels[(25, 8)], self.namespace["COL_RED"])
        self.assertFalse(any(x >= 22 and y < 5 for x, y in pixels))
        self.assertTrue(any(x >= 22 and y >= 11 and color == self.namespace["COL_RED"] for (x, y), color in pixels.items()))

    def test_final_score_puts_own_score_first(self):
        app = self.app()
        app.state = self.namespace["STATE_LOSE"]
        app.draw(None)
        self.assertEqual([(value, color) for _, y, value, color in self.pyxel.texts if y == 9], [
            ("3", self.namespace["COL_YELLOW"]),
            (":", self.namespace["COL_WHITE"]),
            ("5", self.namespace["COL_RED"]),
        ])

    def test_peer_update_freezes_opponent_score_and_ignores_old_round(self):
        app = self.app()
        app.transport_trans_id = "round-a"
        app.ble = types.SimpleNamespace(connected=False)
        app.on_push_message("BDB2|old-round|1|PEER|9|F")
        self.assertEqual(app.opponent_lines, 5)
        app.on_push_message("BDB2|round-a|2|PEER|7|F")
        self.assertEqual(app.opponent_lines, 7)
        self.assertTrue(app.opponent_finished)
        app.on_push_message("BDB2|round-a|3|PEER|6|P")
        self.assertEqual(app.opponent_lines, 7)
        self.assertTrue(app.opponent_finished)
        time.ticks_ms = lambda: 500
        app.draw(None)
        self.assertFalse(any(x >= 22 and y >= 11 for x, y in self.pyxel.pixels))

    def test_result_push_supplies_final_opponent_score(self):
        app = self.app()
        app.state = self.namespace["STATE_FINISHED"]
        app.transport_trans_id = "round-a"
        app.ble = types.SimpleNamespace(connected=False)
        app.send_battle_message = lambda *_: True
        app.next_transport_message_id = lambda: "ack-1"
        app.pending_ack_command_id = ""
        app.pending_ack_message_id = ""
        app.pending_ack_attempts = 0
        app.on_push_message("BDB2|round-a|result-1|LOSE|3|8")
        self.assertEqual(app.state, self.namespace["STATE_LOSE"])
        self.assertEqual(app.lines, 3)
        self.assertEqual(app.opponent_lines, 8)
        app.draw(None)
        self.assertIn((18, 9, "8", self.namespace["COL_RED"]), self.pyxel.texts)


if __name__ == "__main__":
    unittest.main()
