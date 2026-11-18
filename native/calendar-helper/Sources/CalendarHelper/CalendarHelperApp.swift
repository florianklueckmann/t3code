import AppKit

@main
@MainActor
final class CalendarHelperApp: NSObject, NSApplicationDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = CalendarHelperApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 2,
              let files = try? RequestFiles(directory: CommandLine.arguments[1]) else {
            exit(EXIT_FAILURE)
        }
        let request = try? JSONDecoder().decode(CalendarRequest.self, from: files.request)
        let execution = RequestExecution(response: files.response, timeout: request?.timeout ?? .seconds(30))
        Task {
            let response = await CalendarService(store: EventKitStore()).respond(to: request)
            execution.finish(response)
        }
    }
}
