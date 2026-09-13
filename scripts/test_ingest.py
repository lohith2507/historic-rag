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


class HeadingTests(unittest.TestCase):
    def test_extract_heading_reads_canto_and_parva(self):
        ingest = load_ingest_module()

        heading = ingest.extract_heading(
            ["CANTO 21", "ASTIKA PARVA CONTINUED", "auti said, “When the night ended..."]
        )

        self.assertEqual(heading, "Canto 21: Astika Parva")

    def test_extract_heading_skips_dropcap_noise_before_the_marker(self):
        ingest = load_ingest_module()

        heading = ingest.extract_heading(["“S", "CANTO 10", "DRONA PARVA", "anjaya says..."])

        self.assertEqual(heading, "Canto 10: Drona Parva")

    def test_extract_heading_falls_back_to_the_canto_alone(self):
        ingest = load_ingest_module()

        self.assertEqual(ingest.extract_heading(["CANTO 7", "he Rishis said..."]), "Canto 7")

    def test_extract_heading_ignores_table_of_contents_lines(self):
        ingest = load_ingest_module()

        self.assertIsNone(
            ingest.extract_heading(["Canto 32: Astika Parva Continued", "Canto 33: Astika Parva Continued"])
        )

    def test_extract_heading_reads_a_running_chapter_header(self):
        ingest = load_ingest_module()

        self.assertEqual(
            ingest.extract_heading(["Chapter 2", "45", "Comments: Arjuna could argue that..."]),
            "Chapter 2",
        )
        self.assertEqual(ingest.extract_heading(["Introduction", "5. Each regiment consisted..."]), "Introduction")

    def test_extract_heading_ignores_a_chapter_word_inside_prose(self):
        ingest = load_ingest_module()

        self.assertIsNone(ingest.extract_heading(["as Chapter 2 explains, the soul is eternal and..."]))

    def test_extract_heading_returns_none_without_a_marker(self):
        ingest = load_ingest_module()

        self.assertIsNone(ingest.extract_heading(["First published in 2011 by", "Rupa Publications"]))

    def test_build_chunks_carries_the_heading_onto_later_pages(self):
        ingest = load_ingest_module()
        # load_pages captures the heading while the layout is intact; build_chunks carries it.
        pages = [
            ingest.PageText(page=1, text="body text of the first page", heading="Canto 4: Adi Parva"),
            ingest.PageText(page=2, text="continuation with no marker on this page"),
            ingest.PageText(page=3, text="fresh canto begins here", heading="Canto 5: Sabha Parva"),
        ]

        with mock.patch.object(ingest, "chunk_text", lambda text, encoding: [text]), mock.patch(
            "tiktoken.get_encoding", lambda name: FakeEncoding()
        ):
            chunks = ingest.build_chunks("mahabharata", pages)

        self.assertEqual([chunk.heading for chunk in chunks], ["Canto 4: Adi Parva", "Canto 4: Adi Parva", "Canto 5: Sabha Parva"])


class TextSourceTests(unittest.TestCase):
    SAMPLE = "\n".join(
        [
            # Contents listing: carries the same BOOK and Canto markers as the body.
            "BOOK I.",
            "   Canto I. Nárad.",
            "   Canto II. Brahmá's Visit",
            "BOOK II.",
            "   Canto I. The Heir Apparent.",
            "",
            "Canto I. Nárad.",
            "",
            "Om. " + ("verse line about the hermit Valmiki and the sage Narad. " * 8),
            "",
            "Canto II. Brahmá's Visit",
            "",
            "Then " + ("the poet sang of Rama and the forest and the golden deer. " * 8),
            "",
            "BOOK II.",
            "",
            "Canto I. The Heir Apparent.",
            "",
            "Now " + ("the king resolved to name his eldest son as heir to the throne. " * 8),
        ]
    )

    def test_parse_text_sections_finds_each_canto_with_its_book(self):
        ingest = load_ingest_module()

        sections = ingest.parse_text_sections(self.SAMPLE)

        self.assertEqual(len(sections), 3)
        self.assertEqual(sections[0].heading, "Book I (Bálakánda), Canto I: Nárad")
        self.assertEqual(sections[2].heading, "Book II (Ayodhyákánda), Canto I: The Heir Apparent")

    def test_parse_text_sections_ignores_book_markers_in_the_contents(self):
        ingest = load_ingest_module()

        sections = ingest.parse_text_sections(self.SAMPLE)

        # The contents listing ends on BOOK II, but the body opens in Book I.
        self.assertTrue(sections[0].heading.startswith("Book I ("), sections[0].heading)
        self.assertTrue(sections[1].heading.startswith("Book I ("), sections[1].heading)
        self.assertTrue(sections[2].heading.startswith("Book II ("), sections[2].heading)

    def test_parse_text_sections_reads_book_markers_carrying_footnotes(self):
        ingest = load_ingest_module()
        body = "line of verse about the hero and the forest and the deer. " * 8
        text = "\n".join(
            [
                "Canto I. Opening.",
                body,
                "BOOK V.(787)",  # Gutenberg appends a footnote reference to the marker
                "Canto I. The Leap.",
                body,
            ]
        )

        sections = ingest.parse_text_sections(text)

        self.assertTrue(sections[-1].heading.startswith("Book V (Sundarakánda)"), sections[-1].heading)

    def test_parse_text_sections_drops_table_of_contents_entries(self):
        ingest = load_ingest_module()

        sections = ingest.parse_text_sections(self.SAMPLE)

        for section in sections:
            self.assertGreater(len(section.text), 200)

    def test_parse_text_sections_keeps_the_body_text(self):
        ingest = load_ingest_module()

        sections = ingest.parse_text_sections(self.SAMPLE)

        self.assertIn("golden deer", sections[1].text)
        self.assertNotIn("Canto II.", sections[1].text)

    def test_build_chunks_from_sections_sets_heading_and_no_page(self):
        ingest = load_ingest_module()
        sections = ingest.parse_text_sections(self.SAMPLE)

        with mock.patch.object(ingest, "chunk_text", lambda text, encoding: [text]), mock.patch(
            "tiktoken.get_encoding", lambda name: FakeEncoding()
        ):
            chunks = ingest.build_chunks_from_sections("ramayana", sections)

        self.assertEqual(len(chunks), 3)
        self.assertIsNone(chunks[0].page)
        self.assertEqual(chunks[0].heading, "Book I (Bálakánda), Canto I: Nárad")


if __name__ == "__main__":
    unittest.main()
