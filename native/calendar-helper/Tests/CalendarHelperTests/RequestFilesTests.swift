import Darwin
import Foundation
import XCTest
@testable import CalendarHelper

final class RequestFilesTests: XCTestCase {
    private enum GuardCase: CaseIterable {
        case publicDirectory, publicRequest, symlinkRequest, symlinkDirectory
        case existingResponse, fifo, oversizedRequest, badBasename
    }

    func testRejectsUnsafeRequestFiles() throws {
        var path = [CChar](repeating: 0, count: Int(PATH_MAX))
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, &path, path.count)
        XCTAssertTrue(size > 0 && size <= path.count)
        let temp = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        let fileManager = FileManager.default
        let payload = Data(#"{"command":"status"}"#.utf8)

        for test in GuardCase.allCases {
            let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let name = "t3-calendar." + (test == .badBasename ? "bad-" : "") + suffix
            let directory = temp.appendingPathComponent(name, isDirectory: true)
            let alias = temp.appendingPathComponent("t3-calendar." + suffix + "symlink")
            let request = directory.appendingPathComponent("request.json")
            let response = directory.appendingPathComponent("response.json")
            let target = directory.appendingPathComponent("target.json")
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)
            defer {
                _ = unlink(alias.path)
                _ = unlink(request.path)
                _ = unlink(response.path)
                _ = unlink(target.path)
                _ = rmdir(directory.path)
            }
            XCTAssertEqual(chmod(directory.path, test == .publicDirectory ? 0o755 : 0o700), 0)

            switch test {
            case .symlinkRequest:
                try payload.write(to: target)
                XCTAssertEqual(chmod(target.path, 0o600), 0)
                try fileManager.createSymbolicLink(at: request, withDestinationURL: target)
            case .fifo:
                XCTAssertEqual(mkfifo(request.path, 0o600), 0)
            default:
                let data = test == .oversizedRequest ? Data(repeating: 0x20, count: 32 * 1024 + 1) : payload
                try data.write(to: request)
                XCTAssertEqual(chmod(request.path, test == .publicRequest ? 0o644 : 0o600), 0)
            }
            if test == .symlinkDirectory {
                try fileManager.createSymbolicLink(at: alias, withDestinationURL: directory)
            }
            if test == .existingResponse {
                try payload.write(to: response)
                XCTAssertEqual(chmod(response.path, 0o600), 0)
            }
            let submitted = test == .symlinkDirectory ? alias.lastPathComponent : name
            XCTAssertThrowsError(try RequestFiles(directory: submitted), "\(test)")
            if test == .existingResponse {
                XCTAssertEqual(try Data(contentsOf: response), payload, "\(test)")
            } else {
                XCTAssertFalse(fileManager.fileExists(atPath: response.path), "\(test)")
            }
        }
    }
}
