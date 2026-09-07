import importlib.util
import pathlib
import sys
import unittest
from unittest import mock


INGEST_PATH = pathlib.Path(__file__).with_name("ingest.py")


def load_ingest_module():
    spec = importlib.util.spec_from_file_location("ingest", INGEST_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeEncoding:
    def encode(self, text):
        return [int(token) for token in text.split()]

    def decode(self, tokens):
        return " ".join(str(token) for token in tokens)


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class IngestTests(unittest.TestCase):
    def test_select_sources_expands_all_in_stable_order(self):
        ingest = load_ingest_module()

        self.assertEqual(ingest.select_sources("all"), ["gita", "ramayana", "mahabharata"])
        self.assertEqual(ingest.select_sources("gita"), ["gita"])

    def test_chunk_text_uses_target_size_and_overlap(self):
        ingest = load_ingest_module()

        chunks = ingest.chunk_text(" ".join(str(index) for index in range(10)), FakeEncoding(), target_tokens=4, overlap_tokens=1)

        self.assertEqual(chunks, ["0 1 2 3", "3 4 5 6", "6 7 8 9"])

    def test_embed_texts_sorts_batch_results_by_response_index(self):
        ingest = load_ingest_module()
        embedding_a = [0.1] * ingest.EMBEDDING_DIMENSIONS
        embedding_b = [0.2] * ingest.EMBEDDING_DIMENSIONS
        responses = [
            FakeResponse(
                200,
                {
                    "data": [
                        {"index": 1, "embedding": embedding_b},
                        {"index": 0, "embedding": embedding_a},
                    ]
                },
            )
        ]

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def post(self, *args, **kwargs):
                return responses.pop(0)

        fake_httpx = type("FakeHttpx", (), {"Client": FakeClient})

        with mock.patch.dict(sys.modules, {"httpx": fake_httpx}), mock.patch.dict(
            "os.environ", {"OPENROUTER_API_KEY": "test-key"}, clear=False
        ):
            self.assertEqual(ingest.embed_texts(["first", "second"]), [embedding_a, embedding_b])

    def test_embed_texts_retries_transient_openrouter_errors(self):
        ingest = load_ingest_module()
        embedding = [0.3] * ingest.EMBEDDING_DIMENSIONS
        responses = [
            FakeResponse(429, {"error": {"message": "rate limited"}}),
            FakeResponse(200, {"data": [{"index": 0, "embedding": embedding}]}),
        ]

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def post(self, *args, **kwargs):
                return responses.pop(0)

        fake_httpx = type("FakeHttpx", (), {"Client": FakeClient})

        with mock.patch.dict(sys.modules, {"httpx": fake_httpx}), mock.patch.dict(
            "os.environ", {"OPENROUTER_API_KEY": "test-key"}, clear=False
        ), mock.patch("time.sleep"):
            self.assertEqual(ingest.embed_texts(["first"]), [embedding])

    def test_embed_texts_rejects_unexpected_embedding_dimensions(self):
        ingest = load_ingest_module()
        responses = [FakeResponse(200, {"data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]})]

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def post(self, *args, **kwargs):
                return responses.pop(0)

        fake_httpx = type("FakeHttpx", (), {"Client": FakeClient})

        with mock.patch.dict(sys.modules, {"httpx": fake_httpx}), mock.patch.dict(
            "os.environ", {"OPENROUTER_API_KEY": "test-key"}, clear=False
        ):
            with self.assertRaisesRegex(RuntimeError, "1536 dimensions"):
                ingest.embed_texts(["first"])


if __name__ == "__main__":
    unittest.main()
