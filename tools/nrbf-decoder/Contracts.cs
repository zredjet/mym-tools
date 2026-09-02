using System.Text.Json.Serialization;

namespace MyMyTools.NrbfDecoder;

internal sealed record NrbfNode(int Id, int? ParentId, string DisplayName, string RawName,
    string Kind, string? TypeName, string? AssemblyName, string? FormattedValue,
    string? RecordId, int? ReferenceTargetId, int[]? Shape);

internal sealed record NrbfSummary(string Path, string FileName, long FileSizeBytes,
    string? RootType, int NodeCount, IReadOnlyList<string> Warnings, long DurationMs);

internal sealed record InspectResponse(bool Ok, IReadOnlyList<NrbfNode> Nodes,
    NrbfSummary? Summary, string? Error)
{
    public static InspectResponse Failure(string error) => new(false, [], null, error);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(InspectResponse))]
internal sealed partial class NrbfJsonContext : JsonSerializerContext;
