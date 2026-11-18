import Darwin
import Foundation

struct RequestFiles {
    private enum InvalidMailbox: Error {
        case directory, request, response
    }

    let request: Data
    let response: FileHandle

    init(directory name: String) throws {
        guard name.range(of: #"\At3-calendar\.[A-Za-z0-9]{8,64}\z"#, options: .regularExpression) != nil else {
            throw InvalidMailbox.directory
        }
        var path = [CChar](repeating: 0, count: Int(PATH_MAX))
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, &path, path.count)
        guard size > 0, size <= path.count else { throw InvalidMailbox.directory }

        let directory = open(String(cString: path) + name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw InvalidMailbox.directory }
        defer { close(directory) }
        guard Self.isPrivate(directory, mode: S_IFDIR | 0o700) else { throw InvalidMailbox.directory }

        let input = openat(directory, "request.json", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard input >= 0 else { throw InvalidMailbox.request }
        let file = FileHandle(fileDescriptor: input, closeOnDealloc: true)
        defer { try? file.close() }
        let maxBytes = 32 * 1024
        guard Self.isPrivate(input, mode: S_IFREG | 0o600) else { throw InvalidMailbox.request }
        let data = try file.read(upToCount: maxBytes + 1) ?? Data()
        guard data.count <= maxBytes else { throw InvalidMailbox.request }
        request = data

        // Claim the request before dispatch, including before any permission prompt.
        let output = openat(directory, "response.json", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard output >= 0 else { throw InvalidMailbox.response }
        response = FileHandle(fileDescriptor: output, closeOnDealloc: true)
    }

    private static func isPrivate(_ fd: Int32, mode: mode_t) -> Bool {
        var info = stat()
        return fstat(fd, &info) == 0 && info.st_uid == geteuid()
            && (info.st_mode & (S_IFMT | 0o777)) == mode
    }
}
