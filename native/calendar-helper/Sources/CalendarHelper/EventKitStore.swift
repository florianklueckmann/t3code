import EventKit
import Foundation

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
                writable: isWritable($0)
            )
        }
    }

    func events(in query: EventQuery) throws -> [CalendarEvent] {
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        let calendars = query.calendarIDs.compactMap { store.calendar(withIdentifier: $0) }
        guard calendars.count == query.calendarIDs.count else { throw CalendarError.unknownCalendar }
        // EventKit expands recurring events into occurrences when matching a date predicate.
        let predicate = store.predicateForEvents(withStart: query.start, end: query.end, calendars: calendars)
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        return store.events(matching: predicate).compactMap(snapshot)
    }

    func mutate(_ mutation: CalendarMutation) throws -> CalendarEvent? {
        guard authorization == .fullAccess else { throw CalendarError.notAuthorized }
        switch mutation {
        case .create(let calendarId, let marker, let title, let range):
            let calendar = try writableCalendar(calendarId)
            let event = EKEvent(eventStore: store)
            event.calendar = calendar
            event.title = title
            event.notes = Self.ownershipNote(marker)
            setTime(range, on: event)
            try store.save(event, span: .thisEvent, commit: true)
            guard let saved = snapshot(event) else { throw CalendarError.storeUnavailable }
            return saved
        case .update(let calendarId, let target, let title, let range):
            let event = try event(in: writableCalendar(calendarId), matching: target)
            if let range {
                guard range.allDay == event.isAllDay else { throw CalendarError.invalidRequest }
                setTime(range, on: event)
            }
            if let title { event.title = title }
            try store.save(event, span: .thisEvent, commit: true)
            guard let saved = snapshot(event) else { throw CalendarError.storeUnavailable }
            return saved
        case .delete(let calendarId, let target):
            let event = try event(in: writableCalendar(calendarId), matching: target)
            try store.remove(event, span: .thisEvent, commit: true)
            return nil
        }
    }

    private func isWritable(_ calendar: EKCalendar) -> Bool {
        calendar.allowsContentModifications && !calendar.isSubscribed && calendar.type != .birthday
    }

    private func writableCalendar(_ id: String) throws -> EKCalendar {
        guard let calendar = store.calendar(withIdentifier: id) else { throw CalendarError.unknownCalendar }
        guard isWritable(calendar) else { throw CalendarError.readOnlyCalendar }
        return calendar
    }

    private func snapshot(_ event: EKEvent) -> CalendarEvent? {
        guard let start = event.startDate, let end = event.endDate, let calendar = event.calendar else {
            return nil
        }
        return CalendarEvent(
            title: event.title ?? "",
            calendar: CalendarSummary(id: calendar.calendarIdentifier, title: calendar.title),
            start: start, end: end, allDay: event.isAllDay,
            itemID: event.calendarItemIdentifier, occurrenceDate: event.occurrenceDate,
            timeZone: TimeZone.current, lastModifiedAt: event.lastModifiedDate
        )
    }

    private func event(in calendar: EKCalendar, matching target: CalendarMutation.Target) throws -> EKEvent {
        // The occurrence hint finds the same event without exporting native EventKit identifiers.
        let anchor = target.start
        let predicate = store.predicateForEvents(
            withStart: anchor.addingTimeInterval(-60), end: anchor.addingTimeInterval(60), calendars: [calendar]
        )
        let matching = store.events(matching: predicate).filter { candidate in
            candidate.calendar?.calendarIdentifier == calendar.calendarIdentifier &&
                snapshot(candidate)?.reference == target.reference
        }
        guard matching.count == 1, let event = matching.first else { throw CalendarError.eventNotFound }
        guard !event.hasRecurrenceRules, !event.isDetached, !event.hasAttendees, event.organizer == nil
        else { throw CalendarError.unsupportedEvent }
        guard snapshot(event)?.revision == target.revision else { throw CalendarError.eventChanged }
        if let marker = target.requiredMarker, event.notes != Self.ownershipNote(marker) {
            throw CalendarError.eventNotOwned
        }
        return event
    }

    private static func ownershipNote(_ marker: UUID) -> String {
        "T3 Code calendar write: \(marker.uuidString)"
    }

    private func setTime(_ range: CalendarMutation.TimeRange, on event: EKEvent) {
        event.timeZone = range.timeZone
        event.isAllDay = range.allDay
        event.startDate = range.start
        event.endDate = range.end
    }
}
