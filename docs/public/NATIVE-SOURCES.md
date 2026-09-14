# Native source companion

Publish `Latent-native-sources-sharp-0.35.4-libvips-8.18.6.zip` alongside the Windows installer and its checksums. It contains 387 source archives and build inputs, each recorded with origin, byte size and SHA-256 in `SOURCE-MANIFEST.json`. These upstream components retain their own licenses; Latent remains MIT licensed.

## Contents and provenance

- All 28 native library versions in the installed Sharp Windows inventory, verified against the upstream recipe checksums.
- All 350 registry packages in librsvg 2.62.91's Cargo.lock, including optional and development dependencies as a conservative superset.
- GLib's gvdb subproject at its exact wrap-file commit. The web build's included `glib-2-without-gregex.patch` removes PCRE/GRegex; sysprof, docs and tests are disabled. Libffi, proxy-libintl and zlib-ng are already included in the native library set.
- Rust nightly 2026-06-05 source with standard library and vendored dependencies, LLVM 22.1.7 (including compiler-rt/libc++), mingw-w64 and llvm-mingw build inputs.
- libvips Windows recipes and patches at `09cfccf20b91b441fbe97fa7a7ed8a597e55e830`, and MXE recipes at candidate commit `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`.
- Sharp 0.35.4 source at `7f1a0a22cc285fe180766f4935d50b55af6e8432`, and the exact `@img/sharp-libvips-dev` 1.3.3 package containing the separately compiled wrapper sources and headers. That package also passed its npm SHA-512 integrity check.

The installed main `libvips-42.dll` matches the official libvips static web release byte-for-byte. Sharp builds its C++ wrapper separately using `src/binding.gyp`; the differently named C++ DLL in the upstream libvips binary release is not an interchangeable proof of an exact match. See `native-source-provenance.json` for the binary hashes.

The upstream base-image recipe clones a moving MXE branch. The included MXE commit is the reviewed historical candidate, not a proven capture of the original build environment. Compiler-environment identity and bit-for-bit native rebuilds remain unverified. This limitation does not change which library source versions were checksum-verified in this bundle.

## Verify the bundle

Compare the archive's SHA-256 with the release's SHA256SUMS.txt. With Python 3.11 or newer, run:

```text
python scripts/native-source-bundle.py --verify PATH_TO_SOURCE_ZIP
```

The verifier checks every source input's size and SHA-256 and rejects missing, duplicate or unexpected archive entries. The same verifier is included inside the companion ZIP. Python is only needed for this maintainer verification task, not to install Latent.

## Build and replace native libraries

Extract the build-recipes archive and read its README and `build.sh --help`. The matching build flavor is the Windows x64 static web variant:

```text
./build.sh --without-prebuilt -t x86_64-w64-mingw32.static vips-web
```

This is an upstream build command, not a claim that the full native rebuild has been executed here. It requires a Linux Docker/Podman build environment and compiler/tool dependencies. The unmodified upstream base Dockerfile uses a moving branch: for a fixed recipe baseline, use the included MXE archive or pin its clone to the candidate commit above. The container OS/package repositories also need pinning for reproducible builds.

Library archives can be placed into MXE's `pkg` cache using the filenames expected by the included recipes. The supplemental Rust archive is date-qualified in this bundle; the recipe expects `rustc-nightly-src.tar.xz`. Supply gvdb at its pinned subproject revision. The registry `.crate` archives match Cargo.lock checksums and can seed a Cargo cache or vendor tree. This is not a completely offline compiler bootstrap.

For the C++ wrapper and Node addon, use the included Sharp source and its `src/binding.gyp`, the pinned dev package, and Sharp's upstream Windows build instructions. A Windows C++ toolchain and Node/Electron headers are build prerequisites; they are not user installation prerequisites.

Latent ships the native DLLs unpacked under `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib`. Keep the app closed when replacing them, preserve a copy of the originals, and maintain ABI compatibility. A native replacement should be tested before using it with an existing studio.

## Recreate the companion

Acquire the exact inputs listed in `native-source-inputs.json`, retaining their relative paths beneath an input directory. Then:

```text
python scripts/native-source-bundle.py --inputs INPUT_DIRECTORY --output NEW_SOURCE_ZIP
```

The assembler refuses to overwrite an existing archive and includes only its explicit input inventory and public notices. Studio files, private verification logs and model weights are not included.
