import Darwin
import Foundation

let source = CommandLine.arguments[1]
let destination = CommandLine.arguments[2]
let bundleID = Bundle(path: source)?.bundleIdentifier

if renamex_np(source, destination, UInt32(RENAME_EXCL)) != 0 {
    let initialError = errno
    if initialError == EXDEV {
        fputs("Build the helper from a checkout on the same volume as ~/Applications.\n", stderr)
        exit(EXIT_FAILURE)
    }
    guard initialError == EEXIST, let bundleID,
          Bundle(path: destination)?.bundleIdentifier == bundleID else {
        fputs("Cannot install the Calendar Helper at \(destination): \(String(cString: strerror(initialError))).\n", stderr)
        exit(EXIT_FAILURE)
    }
    guard renamex_np(source, destination, UInt32(RENAME_SWAP)) == 0 else {
        perror("Cannot replace the installed Calendar Helper")
        exit(EXIT_FAILURE)
    }
}
