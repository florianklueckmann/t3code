import EventKit

@MainActor
final class EventKitStore: CalendarStore {
    private lazy var store = EKEventStore()

    var authorization: CalendarAuthorization {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .writeOnly: return .writeOnly
        case .fullAccess: return .fullAccess
        @unknown default: return .unknown
        }
    }

    func requestFullAccess() async throws {
        _ = try await store.requestFullAccessToEvents()
    }

    func calendars() throws -> [CalendarDetails] {
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        return store.calendars(for: .event).map {
            CalendarDetails(
                id: $0.calendarIdentifier, title: $0.title, sourceName: $0.source.title,
                writable: $0.allowsContentModifications
            )
        }
    }

    func events(in query: EventQuery) throws -> [CalendarEvent] {
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        let calendars = try query.selectCalendars(store.calendars(for: .event), id: \.calendarIdentifier)
        // EventKit expands recurring events into occurrences when matching a date predicate.
        let predicate = store.predicateForEvents(withStart: query.start, end: query.end, calendars: calendars)
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        return store.events(matching: predicate).compactMap { event in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            return CalendarEvent(
                title: event.title ?? "",
                calendar: CalendarSummary(id: event.calendar.calendarIdentifier, title: event.calendar.title),
                start: start, end: end, allDay: event.isAllDay,
                itemID: event.calendarItemIdentifier, occurrenceDate: event.occurrenceDate
            )
        }
    }
}
