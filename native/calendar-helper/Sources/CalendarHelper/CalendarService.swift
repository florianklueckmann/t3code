import CryptoKit
import Foundation

enum CalendarAuthorization: String, Encodable {
    case notDetermined, restricted, denied, writeOnly, fullAccess, unknown
}

enum CalendarError: String, Error, Encodable {
    case invalidRequest, notAuthorized, unknownCalendar, storeUnavailable, timeout
    case readOnlyCalendar, eventNotFound, eventChanged, unsupportedEvent, eventNotOwned
}

struct CalendarSummary: Encodable {
    let id: String
    let title: String
}

struct CalendarDetails: Encodable {
    let id: String
    let title: String
    let sourceName: String
    let writable: Bool
}

struct CalendarEvent: Encodable {
    let title: String
    let calendar: CalendarSummary
    let start: Date
    let end: Date
    let allDay: Bool
    let reference: String
    let revision: String
    let timeZone: TimeZone

    init(
        title: String, calendar: CalendarSummary, start: Date, end: Date, allDay: Bool,
        itemID: String, occurrenceDate: Date?, timeZone: TimeZone, lastModifiedAt: Date? = nil
    ) {
        self.title = title
        self.calendar = calendar
        self.start = start
        self.allDay = allDay
        self.timeZone = timeZone
        var hostCalendar = Calendar(identifier: .gregorian)
        hostCalendar.timeZone = timeZone
        if allDay, let day = hostCalendar.dateInterval(of: .day, for: end), end != day.start {
            self.end = day.end
        } else {
            self.end = end
        }
        let occurrence = occurrenceDate.map { String($0.timeIntervalSinceReferenceDate) } ?? ""
        let identity = "\(calendar.id.utf8.count):\(calendar.id)\(itemID.utf8.count):\(itemID)\(occurrence)"
        self.reference = Data(SHA256.hash(data: Data(identity.utf8))).base64EncodedString()
        let revisionInput = [
            identity, title, String(start.timeIntervalSinceReferenceDate),
            String(self.end.timeIntervalSinceReferenceDate), String(allDay),
            String(describing: lastModifiedAt?.timeIntervalSinceReferenceDate)
        ].map { "\($0.utf8.count):\($0)" }.joined()
        self.revision = Data(SHA256.hash(data: Data(revisionInput.utf8))).base64EncodedString()
    }

    private enum CodingKeys: String, CodingKey {
        case title, calendar, start, end, allDay, reference, revision, timeZone
    }

    func encode(to encoder: Encoder) throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = allDay ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ssxxx"
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encode(calendar, forKey: .calendar)
        try container.encode(formatter.string(from: start), forKey: .start)
        try container.encode(formatter.string(from: end), forKey: .end)
        try container.encode(allDay, forKey: .allDay)
        try container.encode(reference, forKey: .reference)
        try container.encode(revision, forKey: .revision)
        try container.encode(timeZone.identifier, forKey: .timeZone)
    }
}

struct EventQuery {
    let start: Date
    let end: Date
    let calendarIDs: Set<String>
    let limit: Int

    init(start: String?, end: String?, calendarIDs: [String]?, limit: Int?) throws {
        let limit = limit ?? 50
        guard let start, let end,
              let first = Self.parseBound(start), let last = Self.parseBound(end),
              first < last, last.timeIntervalSince(first) <= 14 * 24 * 60 * 60,
              let calendarIDs, !calendarIDs.isEmpty, calendarIDs.allSatisfy({ !$0.isEmpty }),
              (1...100).contains(limit) else {
            throw CalendarError.invalidRequest
        }
        self.start = first
        self.end = last
        self.calendarIDs = Set(calendarIDs)
        self.limit = limit
    }

    func contains(_ event: CalendarEvent) -> Bool {
        calendarIDs.contains(event.calendar.id) && event.start < end
            && event.end >= event.start && (event.start >= start || event.end > start)
    }

    static func parseBound(_ value: String) -> Date? {
        let timestamp = value.uppercased()
        let pattern = #"\A[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])\z"#
        guard timestamp.range(of: pattern, options: .regularExpression) != nil else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        formatter.isLenient = false
        guard let fraction = timestamp.range(of: #"\.[0-9]+"#, options: .regularExpression) else {
            return formatter.date(from: timestamp)
        }
        let wholeSeconds = timestamp.replacingCharacters(in: fraction, with: "")
        guard let date = formatter.date(from: wholeSeconds),
              let seconds = Double("0" + timestamp[fraction]) else { return nil }
        return date.addingTimeInterval(seconds)
    }
}

@MainActor
protocol CalendarStore {
    var authorization: CalendarAuthorization { get }
    func requestFullAccess() async throws
    func calendars() throws -> [CalendarDetails]
    func events(in query: EventQuery) throws -> [CalendarEvent]
    func mutate(_ mutation: CalendarMutation) throws -> CalendarEvent?
}

enum CalendarResponse: Encodable {
    case status(authorization: CalendarAuthorization)
    case calendars(items: [CalendarDetails])
    case events(items: [CalendarEvent], truncated: Bool?)
    case mutation(event: CalendarEvent?)
    case error(code: CalendarError)

    func json() throws -> Data {
        try JSONEncoder().encode(self)
    }
}

enum CalendarRequest: Decodable {
    case status, setup, listCalendars
    case listEvents(EventQuery)
    case mutateEvent(CalendarMutation)

    private struct Payload: Decodable {
        enum Command: String, Decodable {
            case status, setup
            case listCalendars = "list-calendars"
            case listEvents = "list-events"
            case mutateEvent = "mutate-event"
        }

        let command: Command
        let start: String?
        let end: String?
        let calendarIds: [String]?
        let limit: Int?
        let mutation: CalendarMutation?
    }

    init(from decoder: Decoder) throws {
        let payload = try Payload(from: decoder)
        switch payload.command {
        case .status: self = .status
        case .setup: self = .setup
        case .listCalendars: self = .listCalendars
        case .mutateEvent:
            guard let mutation = payload.mutation else { throw CalendarError.invalidRequest }
            self = .mutateEvent(mutation)
        case .listEvents:
            self = .listEvents(try EventQuery(
                start: payload.start, end: payload.end, calendarIDs: payload.calendarIds,
                limit: payload.limit
            ))
        }
    }

    var timeout: DispatchTimeInterval {
        if case .setup = self { return .seconds(180) }
        return .seconds(30)
    }
}

@MainActor
struct CalendarService {
    let store: any CalendarStore

    func respond(to request: CalendarRequest?) async -> CalendarResponse {
        guard let request else { return .error(code: .invalidRequest) }
        do {
            switch request {
            case .status:
                return .status(authorization: store.authorization)
            case .setup:
                if store.authorization == .notDetermined || store.authorization == .writeOnly {
                    try await store.requestFullAccess()
                }
                return .status(authorization: store.authorization)
            case .listCalendars:
                guard store.authorization == .fullAccess else { return .error(code: .notAuthorized) }
                return .calendars(items: try store.calendars())
            case .mutateEvent(let mutation):
                guard store.authorization == .fullAccess else { return .error(code: .notAuthorized) }
                return .mutation(event: try store.mutate(mutation))
            case .listEvents(let query):
                guard store.authorization == .fullAccess else { return .error(code: .notAuthorized) }
                let available = Set(try store.calendars().map(\.id))
                guard query.calendarIDs.isSubset(of: available) else { return .error(code: .unknownCalendar) }
                let events = try store.events(in: query).filter(query.contains).sorted {
                    ($0.start, $0.reference) < ($1.start, $1.reference)
                }
                return .events(
                    items: Array(events.prefix(query.limit)), truncated: events.count > query.limit ? true : nil
                )
            }
        } catch let error as CalendarError {
            return .error(code: error)
        } catch {
            return .error(code: .storeUnavailable)
        }
    }
}
