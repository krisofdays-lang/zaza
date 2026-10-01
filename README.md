# zaza

IPA patching toolkit — inject dylib into iOS apps.

## Quick Start

```bash
./patch_ipa.sh App.ipa tweak.dylib
# Output: patched_App.ipa
```

## What It Does

1. Extracts the IPA (zip archive)
2. Copies dylib into `Payload/App.app/Frameworks/`
3. Adds `LC_LOAD_DYLIB` load command to the Mach-O binary (via optool/insert_dylib)
4. Re-signs binary and dylib (ad-hoc via ldid or codesign)
5. Repackages into a new IPA

## Requirements

One of these injection tools:
- [optool](https://github.com/optool/optool) — `brew install optool`
- [insert_dylib](https://github.com/tyilo/insert_dylib)

One of these signing tools:
- [ldid](https://github.com/ProcursusTeam/ldid) — `brew install ldid`
- `codesign` (built into macOS)

## Usage

```bash
./patch_ipa.sh <input.ipa> <tweak.dylib> [output.ipa]
```

| Argument | Description |
|---|---|
| `input.ipa` | Original IPA file |
| `tweak.dylib` | Dylib to inject |
| `output.ipa` | Output path (default: `patched_<input>.ipa`) |

## How Load Command Injection Works

The script adds a load command to the app's Mach-O binary:

```
LC_LOAD_DYLIB
  @executable_path/Frameworks/tweak.dylib
```

When iOS loads the app, it loads all dylibs listed in the binary's load commands. By adding your dylib there, it runs automatically at app launch — the dylib's constructor (`__attribute__((constructor))`) fires before `main()`.

## Installation of Patched IPA

- **TrollStore** — direct install, no signing needed (iOS 14–16.6.1, some 17.0)
- **AltStore** — requires Apple ID, 7-day re-sign cycle (free) or 1 year (dev account)
- **Signing service** — enterprise cert + mobile config profile

## Example: Creating a Tweak Dylib

```objc
// tweak.m
#import <Foundation/Foundation.h>

__attribute__((constructor))
static void init() {
    NSLog(@"[Tweak] Loaded!");
    // Hook methods with substrate/fishhook/etc.
}
```

Build with:
```bash
clang -shared -o tweak.dylib tweak.m \
    -target arm64-apple-ios14.0 \
    -isysroot $(xcrun --sdk iphoneos --show-sdk-path) \
    -framework Foundation
```
