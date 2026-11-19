# Maintainer media merge smoke sample

This generated 0.5-second, 64 × 64 video is a small fixture for verifying the trusted **Publish merged template media** workflow. It contains a synthetic test pattern and no third-party material.

[Download the smoke sample](https://releases.open-design.ai/open-motion/media/sha256/eb700b816ed952525efe786e10b0a18f1349bfd7dddd60061d2e306110425466.webm).

The live rehearsal starts with this sample in the contribution branch. After the PR is merged, the trusted workflow uploads and verifies its exact bytes, replaces the link with the public URL, registers its original path and SHA-256 in `repository-media.json`, and removes the video from the sanitized `main` tree. The raw sample must not remain in the current main tree after cleanup.

The registered sample can be restored locally using the existing scoped media download command described in [repository storage](../repository-storage.md#read-and-package-transferred-media). Repeating preparation for unchanged media must not upload it or create another cleanup commit.
