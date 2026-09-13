import XCTest

final class NavigationContinuityTests: XCTestCase {
    @MainActor
    func testFilesDownloadsLargeProjectAndRetriesInterruptedSync() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["NIMBALYST_DOCUMENT_FIXTURE_URL"] else {
            throw XCTSkip("Requires the local document-sync-fixture.cjs server; see ios/TESTING.md")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--screenshot-mode", "--screenshot-screen=sessions", "--document-sync-fixture=\(server)", "-hasPromptedForNotifications", "YES"]
        app.launch()
        defer { app.terminate() }
        let filesTab = app.buttons["Files"]
        XCTAssertTrue(filesTab.waitForExistence(timeout: 10))
        filesTab.tap()
        XCTAssertFalse(app.staticTexts["No Documents"].exists)
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Document 0000.md"].exists)
        app.buttons["Retry"].tap()
        let completed = app.staticTexts["2,293 files"]
        XCTAssertTrue(completed.waitForExistence(timeout: 15))
        app.staticTexts["Document 0000.md"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Downloaded document"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testEmptyListsWaitForIndexSync() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        for (screen, noun) in [("projects", "Projects"), ("sessions", "Sessions")] {
            let app = XCUIApplication()
            app.launchArguments = ["--screenshot-mode", "--screenshot-screen=\(screen)", "--loading-fixture", "-hasPromptedForNotifications", "YES"]
            app.launch()
            defer { app.terminate() }
            let loading = app.staticTexts["Loading \(noun.lowercased())…"]
            XCTAssertTrue(loading.waitForExistence(timeout: 3), "An empty database during sync must show loading")
            XCTAssertFalse(app.staticTexts["No \(noun)"].exists)
            XCTAssertTrue(app.staticTexts["No \(noun)"].waitForExistence(timeout: 15), "A completed empty response must finish loading")
            XCTAssertFalse(loading.exists)
        }
    }

    @MainActor
    func testSearchOpensOldSessionWithTenThousandRetainedRows() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--screenshot-mode", "--screenshot-screen=navigation",
                               "--retained-history-fixture", "-hasPromptedForNotifications", "YES"]
        app.launch()
        defer { app.terminate() }
        let project = app.staticTexts["nimbalyst"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 20))
        project.tap()
        XCTAssertTrue(app.staticTexts["Implement dark mode theme switching"].firstMatch.waitForExistence(timeout: 10))
        let search = app.searchFields.firstMatch
        if !search.isHittable { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Retained history 00000")
        let oldest = app.staticTexts["Retained history 00000"].firstMatch
        XCTAssertTrue(oldest.waitForExistence(timeout: 10), "Search must reach history beyond the materialized window")
        oldest.tap()
        XCTAssertTrue(app.navigationBars["Retained history 00000"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["session-compose-input"].firstMatch.waitForExistence(timeout: 10))
    }

    @MainActor
    func testSessionDraftAndBackHistorySurviveRotation() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--screenshot-mode", "--screenshot-screen=navigation", "-hasPromptedForNotifications", "YES"]
        app.launch()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }

        // Exercise the production navigation tree with an in-memory demo account.
        // On iPad this must start at the same project chooser as on iPhone.
        let project = app.staticTexts["nimbalyst"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let title = "Implement dark mode theme switching"
        let session = app.staticTexts[title].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()
        // SwiftUI's vertical field changes its accessibility type while editing.
        let compose = app.descendants(matching: .any)["session-compose-input"].firstMatch
        XCTAssertTrue(compose.waitForExistence(timeout: 10))
        compose.tap()
        let draft = "Keep this unsent draft through rotation"
        compose.typeText(draft)

        for orientation: UIDeviceOrientation in [.landscapeLeft, .portrait, .landscapeRight, .portrait] {
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), "Rotation must preserve the selected session")
            XCTAssertEqual(compose.value as? String, draft, "Rotation must preserve unsent input")
            if app.frame.width >= 700 {
                let sidebarSession = app.staticTexts["Fix authentication token refresh"].firstMatch
                XCTAssertTrue(sidebarSession.waitForExistence(timeout: 5), "Wide screens must keep the session list beside the transcript")
                XCTAssertTrue(sidebarSession.isHittable)
                XCTAssertLessThan(sidebarSession.frame.maxX, compose.frame.minX)
            }
        }

        if app.frame.width < 700 {
            app.navigationBars[title].buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(session.waitForExistence(timeout: 5), "Back must return to the same project's sessions")
        app.buttons["Choose Project"].tap()
        let otherProject = app.staticTexts["api-server"].firstMatch
        XCTAssertTrue(otherProject.waitForExistence(timeout: 5), "Back must return to the project chooser on every device")
        otherProject.tap()
        XCTAssertTrue(app.navigationBars["api-server"].waitForExistence(timeout: 5))
    }
}
