using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Headers;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Repos.Impl;
using SerbleNotes.Backend.Services;
using SerbleNotes.Backend.Services.Impl;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

JwtSettings jwtSettings = builder.Configuration.GetSection("Jwt").Get<JwtSettings>() ?? throw new Exception("JWT settings not found");

builder.Services.AddOptions<JwtSettings>().Bind(builder.Configuration.GetSection("Jwt"));
builder.Services.AddOptions<SerbleApiSettings>().Bind(builder.Configuration.GetSection("SerbleApi"));
builder.Services.AddOptions<GeneralSettings>().Bind(builder.Configuration.GetSection("General"));

builder.Services.AddHttpClient<ISerbleApiClient, SerbleApiClient>();
builder.Services.AddScoped<IUserRepo, UserRepo>();
builder.Services.AddScoped<IVaultRepo, VaultRepo>();
builder.Services.AddScoped<INoteRepo, NoteRepo>();
builder.Services.AddScoped<IVersionRepo, VersionRepo>();
builder.Services.AddScoped<IVaultAccess, VaultAccess>();
builder.Services.AddScoped<INotesService, NotesService>();
builder.Services.AddScoped<IJwtManager, JwtManager>();

// The socket registry outlives any request, so it is a singleton and the notifier that writes to it
// is one too. Swapping in a Redis-backed notifier later touches only these two lines.
builder.Services.AddSingleton<SyncConnectionManager>();
builder.Services.AddSingleton<ISyncNotifier, InProcessSyncNotifier>();

builder.Services.AddOpenApi();
builder.Services.AddControllers().AddJsonOptions(opts => {
    opts.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    opts.JsonSerializerOptions.DictionaryKeyPolicy  = JsonNamingPolicy.CamelCase;
});
builder.Services.AddAuthorization();

builder.Services.AddAuthentication(options => {
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
}).AddJwtBearer(options => {
    options.TokenValidationParameters = new TokenValidationParameters {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = jwtSettings.Issuer,
        ValidAudience = jwtSettings.Audience,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSettings.Secret))
    };

    options.Events = new JwtBearerEvents {
        // A validly signed token still names an account that has to exist. It can be gone - deleted,
        // or the database restored from a backup taken before it was made - and every row this app
        // writes hangs off a foreign key to it. Without this check the request runs all the way to
        // the database and dies there on a constraint violation, which surfaces as a 500 for what is
        // really just a stale credential. Failing the token makes it the 401 it always was, and the
        // client knows what to do with a 401.
        OnTokenValidated = async context => {
            string? userId = context.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
            if (userId == null) {
                context.Fail("This token does not identify an account.");
                return;
            }

            IUserRepo tokenUsers = context.HttpContext.RequestServices.GetRequiredService<IUserRepo>();
            if (await tokenUsers.GetUser(userId) == null) {
                context.Fail("The account this token was issued for no longer exists.");
            }
        },

        OnMessageReceived = context => {
            // The browser WebSocket API can't send an Authorization header, so the sync endpoint -
            // and only the sync endpoint - accepts the token as a query parameter instead.
            if (context.Request.Path.StartsWithSegments("/api/sync")) {
                string? token = context.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(token)) {
                    context.Token = token;
                }
            }

            return Task.CompletedTask;
        }
    };
});

// The web client is same-origin so it needs none of this, but the Tauri desktop and Android clients
// call the API from custom-protocol origins.
builder.Services.AddCors(options => {
    options.AddPolicy("AllowAll", policy => {
        policy.AllowAnyOrigin()
            .AllowAnyMethod()
            .AllowAnyHeader();
    });
});

string connectionString = builder.Configuration.GetConnectionString("MySql") ?? throw new Exception("MySql connection string not found");
builder.Services.AddDbContext<NotesDatabaseContext>(options =>
    // Pinned rather than auto-detected so that builds, migrations and CI don't need a reachable
    // database just to construct the model.
    options.UseMySql(connectionString, ServerVersion.Parse(builder.Configuration["Database:ServerVersion"] ?? "8.0.0-mysql")));

WebApplication app = builder.Build();

// Bring the schema up to date before serving a single request. EF takes a lock while it runs, so
// several instances starting at once is safe: one applies the migrations and the rest wait.
//
// The retry is not decoration. Started by compose or an orchestrator, this process usually wins the
// race against its own database, and without it the first boot after a deploy fails on a database
// that is seconds away from accepting connections.
await using (AsyncServiceScope scope = app.Services.CreateAsyncScope()) {
    NotesDatabaseContext database = scope.ServiceProvider.GetRequiredService<NotesDatabaseContext>();
    ILogger<Program> startupLogger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    const int attempts = 10;
    for (int attempt = 1; ; attempt++) {
        try {
            IEnumerable<string> pending = await database.Database.GetPendingMigrationsAsync();
            string[] toApply = pending.ToArray();

            if (toApply.Length == 0) {
                startupLogger.LogInformation("Database schema is up to date");
            }
            else {
                startupLogger.LogInformation("Applying {Count} migration(s): {Migrations}",
                    toApply.Length, string.Join(", ", toApply));
                await database.Database.MigrateAsync();
                startupLogger.LogInformation("Migrations applied");
            }

            break;
        }
        catch (Exception e) when (attempt < attempts) {
            // Only connection-time failures are worth retrying, but telling them apart from a broken
            // migration reliably means matching provider error codes. Retrying either is harmless:
            // a genuinely bad migration fails the same way ten seconds later, and then throws.
            startupLogger.LogWarning("Database not ready (attempt {Attempt}/{Attempts}): {Message}",
                attempt, attempts, e.Message);
            await Task.Delay(TimeSpan.FromSeconds(2));
        }
    }
}

if (app.Environment.IsDevelopment()) {
    app.MapOpenApi();
}

app.UseCors("AllowAll");
app.UseWebSockets();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

// Serving the web client out of wwwroot.
//
// Two separate things keep this from shadowing the API. The static file middleware steps aside when
// routing has already matched an endpoint, so /api/* reaches its controller even though this sits
// earlier in the pipeline than the endpoint middleware. And MapFallbackToFile registers at the
// lowest possible priority, and only matches paths that don't look like files - so a missing asset
// still 404s instead of silently returning index.html.
// Cache headers matter more here than they look. Vite content-hashes everything under /assets/, so
// those files can be cached forever - their name changes when their content does. index.html must
// NOT be: it is the thing that names the current bundle, and a browser that caches it keeps loading
// the previous deploy's assets long after they have been replaced. Without an explicit header,
// browsers apply heuristic freshness and do exactly that.
// The mark is published for other sites to embed - /icon.svg and /icon.png, documented in the
// README - so it is cached properly rather than revalidated on every view like the rest of the
// shell. A day is short enough that a redrawn icon reaches an embedding page the same day, and long
// enough that an embed which stays put costs nothing to serve. Nothing else is needed to make this
// work cross-origin: UseCors sits ahead of the static file middleware, so these files answer a
// fetch from another origin as well as a plain <img>.
string[] publishedIcons = ["/icon.svg", "/icon.png", "/favicon-32.png", "/apple-touch-icon.png"];

StaticFileOptions staticFiles = new() {
    OnPrepareResponse = context => {
        ResponseHeaders headers = context.Context.Response.GetTypedHeaders();
        string path = context.Context.Request.Path.Value ?? "";

        if (publishedIcons.Contains(path, StringComparer.OrdinalIgnoreCase)) {
            headers.CacheControl = new CacheControlHeaderValue {
                Public = true,
                MaxAge = TimeSpan.FromDays(1)
            };
        }
        else if (context.Context.Request.Path.StartsWithSegments("/assets")) {
            headers.CacheControl = new CacheControlHeaderValue {
                Public = true,
                MaxAge = TimeSpan.FromDays(365),
                Extensions = { new NameValueHeaderValue("immutable") }
            };
        }
        else {
            // NoCache still allows a 304 against the ETag, so this costs a round trip, not a download.
            headers.CacheControl = new CacheControlHeaderValue { NoCache = true, MustRevalidate = true };
        }
    }
};

app.UseDefaultFiles();
app.UseStaticFiles(staticFiles);

// The fallback needs the same options, or the copy of index.html it serves is uncached-header-less
// again - which is the majority of requests, since deep links go through here.
app.MapFallbackToFile("index.html", staticFiles);

app.Run();
