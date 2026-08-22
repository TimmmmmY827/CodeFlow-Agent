import os
import sys
import unittest

sys.path.insert(0, os.getcwd())

from text_stats import word_frequencies


class HiddenTextStatsTests(unittest.TestCase):
    def test_counts_case_insensitively_and_splits_punctuation(self) -> None:
        self.assertEqual(
            word_frequencies("Red, blue; RED... green42 blue"),
            {"red": 2, "blue": 2, "green42": 1},
        )

    def test_preserves_first_seen_order_and_handles_empty_text(self) -> None:
        result = word_frequencies("B a b C a")
        self.assertEqual(list(result), ["b", "a", "c"])
        self.assertEqual(result, {"b": 2, "a": 2, "c": 1})
        self.assertEqual(word_frequencies("---"), {})


if __name__ == "__main__":
    unittest.main()
