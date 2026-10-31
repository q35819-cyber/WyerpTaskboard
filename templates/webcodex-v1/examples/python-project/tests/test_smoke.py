import unittest


class OnboardingContractSmokeTest(unittest.TestCase):
    def test_python_onboarding_example_exposes_a_runnable_test_gate(self):
        self.assertEqual(1 + 1, 2)


if __name__ == "__main__":
    unittest.main()
