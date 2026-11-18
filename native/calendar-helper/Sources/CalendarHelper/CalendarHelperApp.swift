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
        Task {
            let response = await CalendarService(store: EventKitStore()).respond(to: files.request)
            do {
                try files.response.write(contentsOf: response.json())
                try files.response.close()
                exit(EXIT_SUCCESS)
            } catch {
                exit(EXIT_FAILURE)
            }
        }
    }
}
