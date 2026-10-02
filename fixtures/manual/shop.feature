@shop
Feature: Shopping

  Background:
    Given the app is open on the catalog

  @smoke
  Scenario: Open the cart
    When I tap the cart icon
    Then My Cart shows
    And the cart is empty

  Scenario: Log in with the demo account
    Given I am logged out
    When I open the menu
    And I tap Log In
    Then the Login screen shows
    When I type the demo username and password
      """
      bod@example.com
      """
    And I tap Login
    Then the catalog shows again

  Scenario Outline: Open a product
    When I tap the product "<name>"
    Then its price <price> shows

    Examples:
      | name                | price   |
      | Sauce Labs Backpack | $ 29.99 |
      | Sauce Labs Onesie   | $ 7.99  |

  Scenario: Only a precondition
    Given the app is open
