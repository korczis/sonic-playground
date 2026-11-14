"""The sweep's retry policy (test/e2e/retry.cjs): what is loaded once more, and what stands.

A retry that is too wide hides a defect of the site; one that is too narrow turns main red on a
host's transient answer (GitHub Pages, 503 on 3 of 2006 pages, run 43545986644). Each case below
is a visit result and whether the run is against a live host.
"""

import json
import subprocess
import unittest
from pathlib import Path

POLICY = Path(__file__).resolve().parent / "e2e" / "retry.cjs"
PAGE = "HTTP 503: https://korczis.github.io/sonic-playground/sentiment/vibrant/?v=e997021"


def retry_after(result, live, attempt=1):
    script = (
        "const { retryAfter } = require(process.argv[1]);"
        "const [result, live, attempt] = JSON.parse(process.argv[2]);"
        "process.stdout.write(JSON.stringify(retryAfter(result, live, attempt)));"
    )
    run = subprocess.run(
        ["node", "-e", script, str(POLICY), json.dumps([result, live, attempt])],
        capture_output=True, text=True, check=True,
    )
    return json.loads(run.stdout)


class RetryPolicy(unittest.TestCase):
    def test_a_stalled_page_is_retried_at_once(self):
        self.assertEqual(retry_after({"stalled": True, "errors": ["navigation: timed out"]}, True), 0)

    def test_a_live_hosts_transient_answer_is_retried_after_a_pause(self):
        for status in (429, 502, 503, 504):
            errors = [PAGE.replace("503", str(status), 1)]
            self.assertGreater(retry_after({"stalled": False, "errors": errors}, True), 0)

    def test_a_live_host_gets_three_retries_with_growing_pauses(self):
        # run 43610981553: one page answered 503 twice, 200 a minute later
        pauses = [retry_after({"stalled": False, "errors": [PAGE]}, True, n) for n in (1, 2, 3)]
        self.assertEqual(pauses, sorted(pauses))
        self.assertLess(pauses[0], pauses[-1])
        self.assertIsNone(retry_after({"stalled": False, "errors": [PAGE]}, True, 4))

    def test_a_stalled_page_is_retried_once(self):
        self.assertIsNone(retry_after({"stalled": True, "errors": ["navigation: timed out"]}, True, 2))

    def test_the_artefact_never_retries_a_5xx(self):
        self.assertIsNone(retry_after({"stalled": False, "errors": [PAGE]}, False))

    def test_a_defect_of_the_site_stands(self):
        for errors in (
            ["HTTP 404: https://korczis.github.io/sonic-playground/missing.js"],
            ["HTTP 500: https://korczis.github.io/sonic-playground/"],
            ["console error: Uncaught TypeError"],
            [PAGE, "console error: Uncaught TypeError"],
        ):
            self.assertIsNone(retry_after({"stalled": False, "errors": errors}, True), errors)

    def test_a_clean_page_is_not_retried(self):
        self.assertIsNone(retry_after({"stalled": False, "errors": []}, True))


if __name__ == "__main__":
    unittest.main()
