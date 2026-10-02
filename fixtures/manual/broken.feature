Feature: Broken

  Scenario: Open the menu
    When I tap the menu icon
    Then the menu shows

  Scenario: A broken table
    When I tap the cart icon
      | a | b |
      | c |
    Then My Cart shows

  Scenario: Open the catalog
    When I tap Catalog
    Then Products shows
