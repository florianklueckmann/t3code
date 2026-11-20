import Foundation

enum CalendarMutation: Decodable {
    struct TimeRange: Decodable {
        let start: Date
        let end: Date
        let allDay: Bool
        let timeZone: TimeZone

        private enum CodingKeys: String, CodingKey { case start, end, allDay, timeZone }

        init(from decoder: Decoder) throws {
            let input = try decoder.container(keyedBy: CodingKeys.self)
            guard let start = EventQuery.parseBound(try input.decode(String.self, forKey: .start)),
                  let end = EventQuery.parseBound(try input.decode(String.self, forKey: .end)),
                  start < end, end.timeIntervalSince(start) <= 14 * 24 * 60 * 60,
                  let zone = TimeZone(identifier: try input.decode(String.self, forKey: .timeZone))
            else { throw CalendarError.invalidRequest }
            let allDay = try input.decode(Bool.self, forKey: .allDay)
            if allDay {
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = zone
                guard calendar.startOfDay(for: start) == start,
                      calendar.startOfDay(for: end) == end else { throw CalendarError.invalidRequest }
            }
            self.start = start
            self.end = end
            self.allDay = allDay
            self.timeZone = zone
        }
    }

    struct Target: Decodable {
        let reference: String
        let revision: String
        let start: Date
        let requiredMarker: UUID?

        private enum CodingKeys: String, CodingKey { case reference, revision, start, requiredMarker }

        init(from decoder: Decoder) throws {
            let input = try decoder.container(keyedBy: CodingKeys.self)
            reference = try input.decode(String.self, forKey: .reference)
            revision = try input.decode(String.self, forKey: .revision)
            requiredMarker = try input.decodeIfPresent(UUID.self, forKey: .requiredMarker)
            guard !reference.isEmpty, reference.count <= 128, !revision.isEmpty, revision.count <= 128,
                  let start = EventQuery.parseBound(try input.decode(String.self, forKey: .start))
            else { throw CalendarError.invalidRequest }
            self.start = start
        }
    }

    case create(calendarId: String, marker: UUID, title: String, range: TimeRange)
    case update(calendarId: String, target: Target, title: String?, range: TimeRange?)
    case delete(calendarId: String, target: Target)

    private enum Kind: String, Decodable { case create, update, delete }
    private enum CodingKeys: String, CodingKey { case kind, calendarId, marker, title, range, target }

    init(from decoder: Decoder) throws {
        let input = try decoder.container(keyedBy: CodingKeys.self)
        let calendarId = try input.decode(String.self, forKey: .calendarId)
        guard !calendarId.isEmpty, calendarId.count <= 256 else { throw CalendarError.invalidRequest }
        let title = try input.decodeIfPresent(String.self, forKey: .title)
        if let title {
            guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  title.count <= 500 else { throw CalendarError.invalidRequest }
        }
        switch try input.decode(Kind.self, forKey: .kind) {
        case .create:
            guard let title else { throw CalendarError.invalidRequest }
            self = .create(
                calendarId: calendarId, marker: try input.decode(UUID.self, forKey: .marker),
                title: title, range: try input.decode(TimeRange.self, forKey: .range)
            )
        case .update:
            let range = try input.decodeIfPresent(TimeRange.self, forKey: .range)
            guard title != nil || range != nil else { throw CalendarError.invalidRequest }
            self = .update(
                calendarId: calendarId, target: try input.decode(Target.self, forKey: .target),
                title: title, range: range
            )
        case .delete:
            self = .delete(calendarId: calendarId, target: try input.decode(Target.self, forKey: .target))
        }
    }
}
