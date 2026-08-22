import os
import sys
import unittest

sys.path.insert(0, os.getcwd())

from inventory import available_stock


class HiddenAvailableStockTests(unittest.TestCase):
    def test_clamps_reserved_quantities_and_ignores_unknown_skus(self) -> None:
        stock = {"pen": 5, "book": 1}
        reserved = {"pen": 2, "book": 8, "ghost": 9}
        self.assertEqual(available_stock(stock, reserved), {"pen": 3, "book": 0})

    def test_does_not_mutate_inputs_and_accepts_empty_maps(self) -> None:
        stock = {"pen": 1}
        reserved = {"pen": 1}
        self.assertEqual(available_stock(stock, reserved), {"pen": 0})
        self.assertEqual(stock, {"pen": 1})
        self.assertEqual(reserved, {"pen": 1})
        self.assertEqual(available_stock({}, {}), {})


if __name__ == "__main__":
    unittest.main()
