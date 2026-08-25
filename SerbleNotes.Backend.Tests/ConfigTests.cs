using System.Text.Json;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Tests.Support;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// The one endpoint a client calls before it has an account: the Serble application id it needs to
/// build a sign-in URL, which used to be compiled into the frontend instead.
/// </summary>
public class ConfigTests {

    [Fact]
    public void The_configured_application_id_is_what_a_client_is_told() {
        World world = new();

        ClientConfigResponse config = Assert.IsType<ClientConfigResponse>(
            World.ValueOf(world.ConfigController().Get()));

        Assert.Equal("serble-app-id", config.SerbleAppId);
    }

    [Fact]
    public void An_unconfigured_server_answers_with_an_empty_id_rather_than_null() {
        // The client's check is `if (!appId)`, and a null here would reach it as the string "null"
        // through JSON - an id it would then send to Serble, which refuses it with something about
        // the application rather than about this server.
        World world = new() { SerbleApi = new SerbleApiSettings { BaseUrl = "https://api.serble.test/" } };

        ClientConfigResponse config = Assert.IsType<ClientConfigResponse>(
            World.ValueOf(world.ConfigController().Get()));

        Assert.Equal("", config.SerbleAppId);
    }

    [Fact]
    public void The_client_secret_beside_it_is_not_in_the_answer() {
        // Serialised rather than checked property by property: the failure worth catching is
        // somebody widening this to return the settings object, and that is invisible from here
        // until it is on the wire.
        World world = new();

        string json = JsonSerializer.Serialize(
            Assert.IsType<ClientConfigResponse>(World.ValueOf(world.ConfigController().Get())));

        Assert.DoesNotContain(world.SerbleApi.ClientSecret, json);
    }
}
