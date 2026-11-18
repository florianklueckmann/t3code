import Foundation
import XCTest
@testable import CalendarHelper

private let selected = CalendarDetails(id: "selected", title: "Work", sourceName: "Fixture", writable: true)
private let other = CalendarDetails(id: "other", title: "Personal", sourceName: "Fixture", writable: false)

@MainActor
private final class FakeStore: CalendarStore {
    enum Failure: Error { case offline }

    var authorization: CalendarAuthorization = .fullAccess
    var fails = false
    var promptCount = 0
    var reads = 0
    var eventReads = 0
    var selectedIDs: [String] = []
    var occurrences: [CalendarEvent] = []

    func requestFullAccess() async throws {
        promptCount += 1
        if fails { throw Failure.offline }
        authorization = .fullAccess
    }

    func calendars() throws -> [CalendarDetails] {
        reads += 1
        if fails { throw Failure.offline }
        return [selected, other]
    }

    func events(in query: EventQuery) throws -> [CalendarEvent] {
        reads += 1
        eventReads += 1
        if fails { throw Failure.offline }
        selectedIDs = query.calendarIDs.sorted()
        return occurrences
    }
}

final class CalendarServiceTests: XCTestCase {
    @MainActor
    func testRejectsInvalidBoundsLimitsAndMissingSelectionsBeforeReading() async throws {
        let store = FakeStore()
        let cases: [[String: Any]] = [
            ["start": "2026-02-30T00:00:00Z"],
            ["start": "2026-03-08T00:00:00"],
            ["start": "2026-03-08T00:00:00+24:00"],
            ["start": "2026-03-08T00:00:00Zjunk"],
            ["start": "2026-03-08"],
            ["end": "2026-03-08T00:00:00Z"],
            ["end": "2026-03-07T23:59:59Z"],
            ["end": "2026-03-22T00:00:00.001Z"],
            ["calendarIds": NSNull()],
            ["calendarIds": []],
            ["calendarIds": [""]],
            ["limit": 0],
            ["limit": 101],
            ["limit": 2.5],
        ]
        for state in [CalendarAuthorization.fullAccess, .notDetermined] {
            store.authorization = state
            for fields in cases {
                let result = try await reply(store, eventsRequest(fields))
                XCTAssertEqual(code(result), "invalidRequest", "\(state): \(fields)")
            }
        }
        XCTAssertEqual(store.reads, 0)
    }

    @MainActor
    func testLimitsAndOrdersResults() async throws {
        let store = FakeStore()
        let start = date("2026-03-08T00:00:00Z")
        store.occurrences = (0..<120).reversed().map { minute in
            let time = start.addingTimeInterval(Double(minute * 60))
            return event("Event \(minute)", time, time.addingTimeInterval(60))
        }
        for (fields, count) in [([:], 50), (["limit": 100], 100), (["limit": 1], 1)] {
            let result = try await reply(store, eventsRequest(fields))
            let items = try items(result, "events")
            XCTAssertEqual(items.count, count)
            XCTAssertEqual(items.last?["title"] as? String, "Event \(count - 1)")
            XCTAssertEqual((result["events"] as? [String: Any])?["truncated"] as? Bool, true)
        }
        store.occurrences = Array(store.occurrences.prefix(50))
        let complete = try await reply(store, eventsRequest())
        XCTAssertEqual(try items(complete, "events").count, 50)
        XCTAssertNil((complete["events"] as? [String: Any])?["truncated"])
    }

    @MainActor
    func testCalendarSelectionRejectsMissingIDsAndFiltersUnselectedEvents() async throws {
        let store = FakeStore()
        let start = date("2026-03-08T08:00:00Z")
        let end = date("2026-03-08T09:00:00Z")
        store.occurrences = [event("Allowed", start, end), event("Unselected", start, end, calendar: other)]
        let missing = try await reply(store, eventsRequest(["calendarIds": [selected.id, "retired"]]))
        XCTAssertEqual(code(missing), "unknownCalendar")
        XCTAssertEqual(store.eventReads, 0)
        let result = try await reply(store, eventsRequest(["calendarIds": [selected.id, selected.id]]))
        XCTAssertEqual(store.selectedIDs, [selected.id])
        XCTAssertEqual(try items(result, "events").compactMap { $0["title"] as? String }, ["Allowed"])

        let calendars = try await reply(store, ["command": "list-calendars"])
        XCTAssertEqual(
            try items(calendars, "calendars") as NSArray,
            [
                ["id": "selected", "title": "Work", "sourceName": "Fixture", "writable": true],
                ["id": "other", "title": "Personal", "sourceName": "Fixture", "writable": false],
            ] as NSArray
        )
    }

    @MainActor
    func testRecurringOccurrencesAndAllDayEventAcrossDST() async throws {
        let store = FakeStore()
        let beforeDST = date("2026-03-07T17:00:00Z")
        let recurringStart = date("2026-03-08T09:30:00Z")
        let allDayStart = date("2026-03-08T08:00:00Z")
        let allDayEnd = date("2026-03-09T06:59:59Z")
        let midnight = date("2026-03-09T07:00:00Z")
        let nextDay = date("2026-03-10T07:00:00Z")
        store.occurrences = [
            event("Outside", beforeDST, beforeDST.addingTimeInterval(3600), occurrenceDate: beforeDST),
            event(
                "Recurring", recurringStart, recurringStart.addingTimeInterval(3600), occurrenceDate: recurringStart
            ),
            event("Moved", midnight, midnight.addingTimeInterval(3600), occurrenceDate: nextDay),
            event("All day", allDayStart, allDayEnd, allDay: true),
            event("Starts at end", nextDay, nextDay.addingTimeInterval(3600)),
            event("Ends at start", beforeDST, allDayStart),
        ]
        let result = try await reply(store, eventsRequest([
            "start": "2026-03-08T00:00:00-08:00",
            "end": "2026-03-10T00:00:00-07:00",
        ]))
        let items = try items(result, "events")
        XCTAssertEqual(items.compactMap { $0["title"] as? String }, ["All day", "Recurring", "Moved"])
        let allDay = try XCTUnwrap(items.first)
        XCTAssertEqual(allDay["allDay"] as? Bool, true)
        XCTAssertEqual(allDay["start"] as? String, "2026-03-08")
        XCTAssertEqual(allDay["end"] as? String, "2026-03-09")
        let recurring = try XCTUnwrap(items.dropFirst().first)
        XCTAssertEqual(recurring["start"] as? String, "2026-03-08T01:30:00-08:00")
        XCTAssertEqual(recurring["end"] as? String, "2026-03-08T03:30:00-07:00")
        XCTAssertEqual(recurring["timeZone"] as? String, "America/Los_Angeles")
        XCTAssertEqual(Set(items.compactMap { $0["reference"] as? String }).count, 3)
    }

    @MainActor
    func testExactlyFourteenElapsedDaysWithOffsetsAndFractions() async throws {
        let store = FakeStore()
        let result = try await reply(store, eventsRequest([
            "start": "2026-03-07t23:00:00.125-08:00",
            "end": "2026-03-22T00:00:00.125-07:00",
        ]))
        XCTAssertTrue(try items(result, "events").isEmpty)
    }

    @MainActor
    func testEventJSONOnlyExposesAllowedFieldsAndAnOpaqueReference() async throws {
        let store = FakeStore()
        let start = date("2026-03-08T08:00:00Z")
        store.occurrences = [event("Fixture", start, start.addingTimeInterval(3600))]
        let result = try await reply(store, eventsRequest())
        let item = try XCTUnwrap(try items(result, "events").first)
        XCTAssertEqual(Set(item.keys), ["title", "calendar", "start", "end", "allDay", "timeZone", "reference"])
        XCTAssertEqual(item["calendar"] as? [String: String], ["id": selected.id, "title": selected.title])
        let reference = try XCTUnwrap(item["reference"] as? String)
        XCTAssertEqual(Data(base64Encoded: reference)?.count, 32)
        XCTAssertFalse(reference.contains("private-item-id"))
    }

    @MainActor
    func testStatusAndReadsNeverPromptAndOnlyExplicitSetupRequestsAccess() async throws {
        let store = FakeStore()
        for state in [CalendarAuthorization.notDetermined, .denied, .restricted, .writeOnly, .unknown] {
            store.authorization = state
            let status = try await reply(store, ["command": "status"])
            XCTAssertEqual((status["status"] as? [String: String])?["authorization"], state.rawValue)
            let events = try await reply(store, eventsRequest())
            XCTAssertEqual(code(events), "notAuthorized")
            let calendars = try await reply(store, ["command": "list-calendars"])
            XCTAssertEqual(code(calendars), "notAuthorized")
        }
        XCTAssertEqual(store.promptCount, 0)
        XCTAssertEqual(store.reads, 0)

        store.authorization = .notDetermined
        let setup = try await reply(store, ["command": "setup"])
        XCTAssertEqual((setup["status"] as? [String: String])?["authorization"], "fullAccess")
        XCTAssertEqual(store.promptCount, 1)
    }

    @MainActor
    func testStoreFailureReturnsTypedError() async throws {
        let store = FakeStore()
        store.fails = true
        let events = try await reply(store, eventsRequest())
        XCTAssertEqual(code(events), "storeUnavailable")
        let calendars = try await reply(store, ["command": "list-calendars"])
        XCTAssertEqual(code(calendars), "storeUnavailable")
        store.authorization = .notDetermined
        let setup = try await reply(store, ["command": "setup"])
        XCTAssertEqual(code(setup), "storeUnavailable")
    }

    private func date(_ timestamp: String) -> Date {
        ISO8601DateFormatter().date(from: timestamp)!
    }

    private func event(
        _ title: String, _ start: Date, _ end: Date, calendar: CalendarDetails = selected,
        allDay: Bool = false, occurrenceDate: Date? = nil
    ) -> CalendarEvent {
        CalendarEvent(
            title: title, calendar: CalendarSummary(id: calendar.id, title: calendar.title),
            start: start, end: end, allDay: allDay, itemID: "private-item-id",
            occurrenceDate: occurrenceDate, timeZone: TimeZone(identifier: "America/Los_Angeles")!
        )
    }

    private func eventsRequest(_ overrides: [String: Any] = [:]) -> [String: Any] {
        [
            "command": "list-events",
            "start": "2026-03-08T00:00:00Z",
            "end": "2026-03-22T00:00:00Z",
            "calendarIds": [selected.id],
        ].merging(overrides) { _, override in override }
    }

    @MainActor
    private func reply(_ store: FakeStore, _ request: [String: Any]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: request)
        let command = try? JSONDecoder().decode(CalendarRequest.self, from: data)
        let result = await CalendarService(store: store).respond(to: command)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: result.json()) as? [String: Any])
    }

    private func code(_ response: [String: Any]) -> String? {
        (response["error"] as? [String: String])?["code"]
    }

    private func items(_ response: [String: Any], _ key: String) throws -> [[String: Any]] {
        try XCTUnwrap((response[key] as? [String: Any])?["items"] as? [[String: Any]])
    }
}
