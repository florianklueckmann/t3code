import Darwin
import Foundation

final class RequestExecution: @unchecked Sendable {
    private let response: FileHandle
    private let writing = NSLock()

    init(response: FileHandle, timeout: DispatchTimeInterval) {
        self.response = response
        let deadline = DispatchTime.now() + timeout
        let watchdog = DispatchQueue.global(qos: .userInitiated)
        watchdog.asyncAfter(deadline: deadline) {
            self.finish(.error(code: .timeout))
        }
        // Exit even if the winning response write or the file close is stuck.
        watchdog.asyncAfter(deadline: deadline + .seconds(1)) {
            _exit(EXIT_FAILURE)
        }
    }

    func finish(_ value: CalendarResponse) {
        guard writing.try() else { return }
        do {
            try response.write(contentsOf: value.json())
            try response.close()
            _exit(EXIT_SUCCESS)
        } catch {
            _exit(EXIT_FAILURE)
        }
    }
}
