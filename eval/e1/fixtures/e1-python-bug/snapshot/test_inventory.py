import unittest

from inventory import available_stock


class AvailableStockTests(unittest.TestCase):
    def test_reserved_quantity_never_makes_stock_negative(self) -> None:
        self.assertEqual(available_stock({"pen": 2}, {"pen": 5}), {"pen": 0})


if __name__ == "__main__":
    unittest.main()
