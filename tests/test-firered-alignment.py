"""Targeted acoustic alignment/installer checks; no model download or inference."""
import itertools
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

import numpy as np

RESOURCES = Path(__file__).resolve().parents[1] / "server/resources/firered"
sys.path.insert(0, str(RESOURCES))
from alignment import AlignmentError, viterbi_spans, words_from_tokens
from download_models import extract


def collapsed(path):
    return [token for index, token in enumerate(path) if token and (not index or token != path[index - 1])]


class AlignmentTests(unittest.TestCase):
    def test_matches_exhaustive_acoustic_path(self):
        # Independent small CTC oracle: enumerate paths, not implementation states.
        rng = np.random.default_rng(42)
        for target in ([1, 2], [1, 1], [2]):
            logits = rng.normal(size=(5, 3))
            probs = logits - np.log(np.exp(logits).sum(axis=1, keepdims=True))
            candidates = [path for path in itertools.product(range(3), repeat=5) if collapsed(path) == list(target)]
            best = max(candidates, key=lambda path: sum(probs[frame, token] for frame, token in enumerate(path)))
            spans = viterbi_spans(probs, target)
            positions = []
            for index, token in enumerate(best):
                if token and (not index or token != best[index - 1]):
                    positions.append([index, index + 1])
                elif token:
                    positions[-1][1] = index + 1
            self.assertEqual([[first, last] for first, last, _ in spans], positions)

    def test_repeats_require_blank_and_impossible_path_rejected(self):
        probs = np.full((3, 2), -np.inf)
        probs[0, 1] = probs[1, 0] = probs[2, 1] = 0
        self.assertEqual([(a, b) for a, b, _ in viterbi_spans(probs, [1, 1])], [(0, 1), (2, 3)])
        for invalid in (np.zeros((2, 2)), np.full((3, 2), -np.inf)):
            with self.assertRaises(AlignmentError):
                viterbi_spans(invalid, [1, 1])

    def test_word_grouping_and_audio_bounds(self):
        words = words_from_tokens(['你', '▁HEL', 'LO', '好'], [(0,1,.9),(2,3,.8),(3,4,.7),(5,6,.9)], .04, 1, 2)
        self.assertEqual([word['text'] for word in words], ['你','HELLO','好'])
        self.assertEqual(words[1]['start'], 1.12)
        self.assertEqual(words[1]['end'], 1.20)
        with self.assertRaises(AlignmentError):
            words_from_tokens(['你'], [(25,26,.9)], .04, 0, 1)

    def test_archive_traversal_and_links_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, link in [('model/../../outside', False), ('model/link', True)]:
                archive = root / 'model.tar.bz2'
                with tarfile.open(archive, 'w:bz2') as output:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type, member.linkname = tarfile.SYMTYPE, '../outside'
                    output.addfile(member)
                with self.assertRaises(ValueError):
                    extract(archive, root / 'target')
            self.assertFalse((root / 'outside').exists())


if __name__ == '__main__':
    unittest.main()
