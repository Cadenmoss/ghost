//
//  GhostIntents.swift
//  Added to StikDebug by ghost (not upstream). Copied in by vendor/prepare-stikdebug.sh.
//
//  Exposes location control to Shortcuts, so a spoof can be started from anywhere
//  on cellular in one tap.
//
//  Why this exists: iOS will not BUILD StikDebug's tunnel while cellular data is
//  the active connection, but a tunnel that is already built keeps working on
//  cellular. StikDebug's own error says as much ("Wi-Fi connected or Cellular Data
//  disabled").
//
//  Important, learned the hard way: location simulation does NOT ride StikDebug's
//  main tunnel. simulate_location() builds its own (tunnel_create_rppairing) on
//  first use and caches it. So the location must be SET inside the cellular-off
//  window, which means the place must be looked up BEFORE that window (lookup
//  needs internet; setting does not). Hence: Find Place -> Cellular Data Off ->
//  Simulate Location (coordinates) -> Cellular Data On. Error 3 from
//  simulate_location is providerCreate: that tunnel failed to build.
//

import AppIntents
import CoreLocation
import Foundation
import MapKit

struct GhostIntentError: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    var localizedStringResource: LocalizedStringResource { LocalizedStringResource(stringLiteral: message) }
}

/// Poll StikDebug's tunnel state until it is up, or give up.
private func ghostWaitForTunnel(timeout: TimeInterval) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let (connected, starting) = await MainActor.run {
            (TunnelManager.shared.isConnected, TunnelManager.shared.isStarting)
        }
        if connected && !starting { return true }
        try? await Task.sleep(nanoseconds: 300_000_000)
    }
    return await MainActor.run { TunnelManager.shared.isConnected }
}

private func ghostTunnelErrorText() async -> String {
    await MainActor.run { TunnelManager.shared.lastError?.localizedDescription ?? "timed out" }
}

private func ghostRun(_ work: @escaping () -> Int32) async -> Int32 {
    await withCheckedContinuation { continuation in
        LocationSimulationCommandQueue.shared.async {
            continuation.resume(returning: work())
        }
    }
}

/// "lat,lon" -> coordinate, if the text is exactly that.
func ghostParseCoordinate(_ text: String) -> CLLocationCoordinate2D? {
    let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    guard parts.count == 2, let lat = Double(parts[0]), let lon = Double(parts[1]),
          (-90...90).contains(lat), (-180...180).contains(lon) else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
}

// MARK: - Find Place

struct GhostFindPlaceIntent: AppIntent {
    static var title: LocalizedStringResource = "Find Place"
    static var description = IntentDescription(
        "Look up a place and return its coordinates as \"lat,lon\". Run this while you still have internet, before turning Cellular Data off; pass the result to Simulate Location."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Place", description: "An address or place name, e.g. Fenway Park.")
    var place: String

    static var parameterSummary: some ParameterSummary {
        Summary("Find \(\.$place)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let query = place.trimmingCharacters(in: .whitespacesAndNewlines)
        if let saved = GhostPlaces.find(query) {
            return .result(value: saved.coordinateText, dialog: "\(saved.name)")
        }
        if let direct = ghostParseCoordinate(query) {
            return .result(value: String(format: "%.6f,%.6f", direct.latitude, direct.longitude), dialog: "Using those coordinates")
        }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        let response: MKLocalSearch.Response
        do {
            response = try await MKLocalSearch(request: request).start()
        } catch {
            throw GhostIntentError(message: "Couldn't look up \"\(query)\" (\(error.localizedDescription)). Is there internet?")
        }
        guard let item = response.mapItems.first else {
            throw GhostIntentError(message: "No place found for \"\(query)\".")
        }
        let c: CLLocationCoordinate2D
        if #available(iOS 26.0, *) { c = item.location.coordinate } else { c = item.placemark.coordinate }
        let value = String(format: "%.6f,%.6f", c.latitude, c.longitude)
        return .result(value: value, dialog: "\(item.name ?? query)")
    }
}

// MARK: - Reconnect

struct GhostReconnectIntent: AppIntent {
    static var title: LocalizedStringResource = "Reconnect Device"
    static var description = IntentDescription(
        "Rebuild StikDebug's main tunnel (JIT, app list). Location simulation builds its own tunnel inside Simulate Location, so this is not needed for spoofing."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Force", description: "Rebuild even if StikDebug reports it is already connected.", default: false)
    var force: Bool

    func perform() async throws -> some IntentResult & ReturnsValue<Bool> & ProvidesDialog {
        let alreadyUp = await MainActor.run { TunnelManager.shared.isConnected }
        if alreadyUp && !force {
            return .result(value: true, dialog: "Already connected")
        }
        await ensureTunnel()
        guard await ghostWaitForTunnel(timeout: 15) else {
            throw GhostIntentError(message: "Tunnel did not come up: \(await ghostTunnelErrorText()). Is LocalDevVPN connected, and Cellular Data off?")
        }
        return .result(value: true, dialog: "Device connected")
    }
}

// MARK: - Simulate

struct GhostSimulateLocationIntent: AppIntent {
    static var title: LocalizedStringResource = "Simulate Location"
    static var description = IntentDescription(
        "Move the device to a place name or to coordinates, with no confirmation dialog. Needs a connected tunnel; use Reconnect Device first if you're on cellular."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Place", description: "An address or place name, e.g. Fenway Park. Leave empty to use coordinates.")
    var place: String?

    @Parameter(title: "Latitude")
    var latitude: Double?

    @Parameter(title: "Longitude")
    var longitude: Double?

    static var parameterSummary: some ParameterSummary {
        Summary("Simulate location at \(\.$place)") {
            \.$latitude
            \.$longitude
        }
    }

    private func resolve() async throws -> (CLLocationCoordinate2D, String) {
        if let latitude, let longitude {
            guard (-90...90).contains(latitude), (-180...180).contains(longitude) else {
                throw GhostIntentError(message: "Latitude must be -90…90 and longitude -180…180.")
            }
            return (CLLocationCoordinate2D(latitude: latitude, longitude: longitude), "Coordinates")
        }
        guard let query = place?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else {
            throw GhostIntentError(message: "Give a place name, or both latitude and longitude.")
        }
        if let saved = GhostPlaces.find(query) {
            return (CLLocationCoordinate2D(latitude: saved.latitude, longitude: saved.longitude), saved.name)
        }
        // "42.3467,-71.0972" (what Find Place returns) needs no lookup, so it
        // works with Cellular Data off.
        if let parsed = ghostParseCoordinate(query) {
            return (parsed, "Coordinates")
        }
        // Looking a place up needs internet; the location change itself does not.
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        let response: MKLocalSearch.Response
        do {
            response = try await MKLocalSearch(request: request).start()
        } catch {
            throw GhostIntentError(message: "Couldn't look up \"\(query)\" — is Cellular Data back on? (\(error.localizedDescription))")
        }
        guard let item = response.mapItems.first else {
            throw GhostIntentError(message: "No place found for \"\(query)\".")
        }
        let coordinate: CLLocationCoordinate2D
        if #available(iOS 26.0, *) {
            coordinate = item.location.coordinate
        } else {
            coordinate = item.placemark.coordinate
        }
        return (coordinate, item.name ?? query)
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let (coordinate, name) = try await resolve()

        if !(await MainActor.run { TunnelManager.shared.isConnected }) {
            await ensureTunnel()
            guard await ghostWaitForTunnel(timeout: 15) else {
                throw GhostIntentError(message: "Device not connected (\(await ghostTunnelErrorText())). On cellular: turn Cellular Data off, run Reconnect Device, turn it back on.")
            }
        }

        let pairingFile = PairingFileStore.prepareURL()
        guard FileManager.default.fileExists(atPath: pairingFile.path) else {
            throw GhostIntentError(message: "No pairing file. In StikDebug: Settings › Pair a Device.")
        }

        let ip = DeviceConnectionContext.targetIPAddress
        let code = await ghostRun {
            simulate_location(ip, coordinate.latitude, coordinate.longitude, pairingFile.path)
        }
        guard code == 0 else {
            if code == 3 {
                throw GhostIntentError(message: "Couldn't build the location tunnel (error 3). iOS refuses this while Cellular Data is on: run Simulate Location while it's off, and check LocalDevVPN is connected.")
            }
            throw GhostIntentError(message: "Location simulation failed (error \(code)). Make sure LocalDevVPN is connected and the DDI is mounted.")
        }

        // Same keep-alive the in-app button uses: resend every few seconds, with
        // StikDebug's background audio/location assertions holding the app awake.
        await MainActor.run {
            LocationSimulationSession.shared.clearRoute()
            LocationSimulationSession.shared.startResending(at: coordinate) {
                LocationSimulationCommandQueue.shared.async {
                    _ = simulate_location(ip, coordinate.latitude, coordinate.longitude, pairingFile.path)
                }
            }
            LogManager.shared.addInfoLog(
                String(format: "Shortcuts: simulated %@ (%.6f, %.6f)", name, coordinate.latitude, coordinate.longitude)
            )
        }

        let summary = String(format: "%@ (%.5f, %.5f)", name, coordinate.latitude, coordinate.longitude)
        return .result(value: summary, dialog: "Now at \(summary)")
    }
}

// MARK: - Clear

struct GhostClearLocationIntent: AppIntent {
    static var title: LocalizedStringResource = "Clear Simulated Location"
    static var description = IntentDescription("Stop simulating and return the device to its real location.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let code = await ghostRun { clear_simulated_location() }
        await MainActor.run { LocationSimulationSession.shared.stop() }
        guard code == 0 else {
            throw GhostIntentError(message: "Clear failed (error \(code)).")
        }
        return .result(dialog: "Back to your real location")
    }
}

// MARK: - Saved places
//
// Named spots ("my dorm") kept in StikDebug's own storage, so a saved place
// needs no internet to look up. Names match loosely: case, extra spaces and a
// leading "my " are ignored, so "My Dorm", "dorm" and "my dorm" are the same.

struct GhostSavedPlace: Codable {
    var name: String
    var latitude: Double
    var longitude: Double
    var coordinateText: String { String(format: "%.6f,%.6f", latitude, longitude) }
}

enum GhostPlaces {
    static let otherOption = "Somewhere else…"
    private static let key = "ghost.savedPlaces"

    static func normalize(_ name: String) -> String {
        var n = name.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if n.hasPrefix("my ") { n.removeFirst(3) }
        return n
    }

    static func all() -> [GhostSavedPlace] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let list = try? JSONDecoder().decode([GhostSavedPlace].self, from: data) else { return [] }
        return list
    }

    private static func store(_ list: [GhostSavedPlace]) {
        let sorted = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if let data = try? JSONEncoder().encode(sorted) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func find(_ name: String) -> GhostSavedPlace? {
        let n = normalize(name)
        guard !n.isEmpty else { return nil }
        return all().first { normalize($0.name) == n }
    }

    /// Saving a name that already exists moves it.
    static func save(_ place: GhostSavedPlace) {
        var list = all().filter { normalize($0.name) != normalize(place.name) }
        list.append(place)
        store(list)
    }

    @discardableResult
    static func remove(_ name: String) -> GhostSavedPlace? {
        let list = all()
        guard let hit = list.first(where: { normalize($0.name) == normalize(name) }) else { return nil }
        store(list.filter { normalize($0.name) != normalize(name) })
        return hit
    }
}

struct GhostSavePlaceIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Place"
    static var description = IntentDescription(
        "Save a spot under a name, like \"my dorm\", so Spoof can go there without looking it up. Give either a location (e.g. Current Location) or an address."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Name", description: "What you'll call it, e.g. My Dorm.")
    var name: String

    @Parameter(title: "Location", description: "A location, such as the output of Get Current Location.")
    var location: CLPlacemark?

    @Parameter(title: "Address", description: "An address, place name or \"lat,lon\". Used when Location is empty.")
    var place: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Save \(\.$name)") {
            \.$location
            \.$place
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label != GhostPlaces.otherOption else {
            throw GhostIntentError(message: "Give the place a name.")
        }

        let c: CLLocationCoordinate2D
        if let spot = location?.location?.coordinate {
            c = spot
        } else if let query = place?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            if let saved = GhostPlaces.find(query) {
                c = CLLocationCoordinate2D(latitude: saved.latitude, longitude: saved.longitude)
            } else if let direct = ghostParseCoordinate(query) {
                c = direct
            } else {
                let request = MKLocalSearch.Request()
                request.naturalLanguageQuery = query
                let response: MKLocalSearch.Response
                do {
                    response = try await MKLocalSearch(request: request).start()
                } catch {
                    throw GhostIntentError(message: "Couldn't look up \"\(query)\" (\(error.localizedDescription)). Is there internet?")
                }
                guard let item = response.mapItems.first else {
                    throw GhostIntentError(message: "No place found for \"\(query)\".")
                }
                if #available(iOS 26.0, *) { c = item.location.coordinate } else { c = item.placemark.coordinate }
            }
        } else {
            throw GhostIntentError(message: "Give a location or an address to save.")
        }

        let existed = GhostPlaces.find(label) != nil
        GhostPlaces.save(GhostSavedPlace(name: label, latitude: c.latitude, longitude: c.longitude))
        let text = String(format: "%.5f, %.5f", c.latitude, c.longitude)
        return .result(value: label, dialog: "\(existed ? "Updated" : "Saved") \(label) (\(text))")
    }
}

struct GhostListPlacesIntent: AppIntent {
    static var title: LocalizedStringResource = "Saved Places"
    static var description = IntentDescription("The names of your saved places, A to Z, ready for Choose from List.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Add \"Somewhere else…\"", description: "Put a \"Somewhere else…\" choice at the end of the list.", default: true)
    var includeOther: Bool

    func perform() async throws -> some IntentResult & ReturnsValue<[String]> {
        let names = GhostPlaces.all().map(\.name)
        if !includeOther && names.isEmpty {
            throw GhostIntentError(message: "No saved places yet. Use Save Place first.")
        }
        return .result(value: includeOther ? names + [GhostPlaces.otherOption] : names)
    }
}

struct GhostForgetPlaceIntent: AppIntent {
    static var title: LocalizedStringResource = "Forget Place"
    static var description = IntentDescription("Delete a saved place.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Name")
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Forget \(\.$name)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let gone = GhostPlaces.remove(name) else {
            throw GhostIntentError(message: "No saved place called \"\(name)\".")
        }
        return .result(dialog: "Forgot \(gone.name)")
    }
}
