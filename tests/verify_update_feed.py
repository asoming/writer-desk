"""Only validated public platform artifacts may enter the anonymous update feed."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("update_feed", ROOT / "scripts/generate-update-feed.py")
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


def release(version="0.8.1", prerelease=True):
    tag = "v" + version
    assets = []
    for suffix in feed.SUFFIXES:
        name = "WriterDesk-" + version + "-" + suffix
        for filename, size in ((name, 4096), (feed.checksum_name(name), 110)):
            assets.append({"name": filename, "size": size, "state": "uploaded",
                           "browser_download_url": feed.RELEASE_ROOT + tag + "/" + filename,
                           "uploader": {"secret": "must not be published"}})
    return {"tag_name": tag, "draft": False, "prerelease": prerelease,
            "published_at": "2026-10-15T06:42:00Z", "body": "更新说明🌊", "assets": assets,
            "author": {"private": "must not be published"}}


class UpdateFeedTests(unittest.TestCase):
    def test_preserves_published_preview_and_stable_with_only_required_public_fields(self):
        source = [release("0.8.0"), release("0.8.1", False)]
        original = copy.deepcopy(source)
        result = json.loads(feed.encoded_feed(source))
        self.assertEqual([item["tag_name"] for item in result], ["v0.8.1", "v0.8.0"])
        self.assertEqual([item["prerelease"] for item in result], [False, True])
        self.assertEqual(len(result[0]["assets"]), 10)
        self.assertEqual(result[0]["assets"][3]["name"], "WriterDesk-0.8.1-linux-x64.sha256")
        self.assertEqual(result[0]["body"], "更新说明🌊")
        self.assertNotIn("must not be published", feed.encoded_feed(source).decode())
        self.assertEqual(source, original)

    def test_drafts_missing_publication_and_invalid_tags_are_excluded(self):
        for key, value in (("draft", True), ("draft", 0), ("prerelease", 1),
                           ("published_at", None), ("published_at", "not a date"),
                           ("published_at", "2026-10-15T06:42:00"),
                           ("tag_name", "v0.8.1-beta"), ("tag_name", "v0.8.1/../other")):
            with self.subTest(key=key, value=value):
                item = release();item[key] = value
                self.assertEqual(feed.release_feed([item]), [])

    def test_missing_duplicate_or_unuploaded_checksum_excludes_that_platform(self):
        for change in ("missing", "duplicate", "unfinished"):
            with self.subTest(change=change):
                item = release()
                if change == "missing":item["assets"].pop(1)
                elif change == "duplicate":item["assets"].append(copy.deepcopy(item["assets"][1]))
                else:item["assets"][1]["state"] = "new"
                result = feed.release_feed([item])[0]
                self.assertEqual(len(result["assets"]), 8)
                self.assertFalse(any(asset["name"].endswith(".deb") for asset in result["assets"]))

    def test_wrong_repository_external_query_or_credential_urls_cannot_be_published(self):
        for url in ("https://evil.example/package.deb", "http://github.com/asoming/writer-desk/file",
                    feed.RELEASE_ROOT + "v0.8.1/WriterDesk-0.8.1-linux-amd64.deb?redirect=1",
                    "https://user:pass@github.com/asoming/writer-desk/releases/download/v0.8.1/WriterDesk-0.8.1-linux-amd64.deb",
                    feed.RELEASE_ROOT.replace("asoming/", "other/") + "v0.8.1/WriterDesk-0.8.1-linux-amd64.deb"):
            with self.subTest(url=url):
                item = release();item["assets"][0]["browser_download_url"] = url
                self.assertEqual(len(feed.release_feed([item])[0]["assets"]), 8)

    def test_asset_bounds_and_boolean_sizes_are_rejected_without_affecting_other_platforms(self):
        for index, value in ((0, 0), (0, -1), (0, True), (0, feed.MAX_ASSET + 1), (1, 1025)):
            with self.subTest(index=index, value=value):
                item = release();item["assets"][index]["size"] = value
                self.assertEqual(len(feed.release_feed([item])[0]["assets"]), 8)

    def test_limits_notes_and_releases_by_semantic_version_not_api_order(self):
        source = [release("0.8." + str(index)) for index in range(40)]
        source[-1]["body"] = "长" * 10000
        result = feed.release_feed(source)
        self.assertEqual(len(result), 30)
        self.assertEqual(result[0]["tag_name"], "v0.8.39")
        self.assertEqual(result[-1]["tag_name"], "v0.8.10")
        self.assertEqual(len(result[0]["body"]), 4000)
        self.assertLess(len(feed.encoded_feed(source)), feed.MAX_FEED)

    def test_invalid_top_level_and_duplicate_tags_fail_instead_of_publishing_empty_success(self):
        for source in ({"message": "API rate limit exceeded"}, [release()] * 101,
                       [release(), release()]):
            with self.subTest(source_type=type(source).__name__):
                with self.assertRaises(ValueError):feed.encoded_feed(source)
        self.assertEqual(feed.encoded_feed([]), b"[]\n")


if __name__ == "__main__":
    unittest.main()
