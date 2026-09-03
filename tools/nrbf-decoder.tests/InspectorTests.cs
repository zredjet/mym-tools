using System.Text;
using MyMyTools.NrbfDecoder;
using Xunit;

namespace NrbfDecoder.Tests;

public sealed class InspectorTests
{
    [Fact]
    public void ReadsUnicodeStringWithoutLoadingAType()
    {
        using TemporaryFile file = new(BuildStringPayload("こんにちは NRBF"));

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        NrbfNode node = Assert.Single(response.Nodes);
        Assert.Equal("scalar", node.Kind);
        Assert.Equal("こんにちは NRBF", node.FormattedValue);
        Assert.Equal("System.String", response.Summary?.RootType);
    }

    [Fact]
    public void ReadsPrimitiveArrayAfterCheckingItsLength()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(15); // ArraySinglePrimitive
        WriteInt32(payload, 1);
        WriteInt32(payload, 3);
        payload.WriteByte(8); // Int32
        WriteInt32(payload, 10);
        WriteInt32(payload, 20);
        WriteInt32(payload, 30);
        payload.WriteByte(11); // MessageEnd
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal(["array", "scalar", "scalar", "scalar"], response.Nodes.Select(node => node.Kind));
        int[] shape = Assert.IsType<int[]>(response.Nodes[0].Shape);
        Assert.Equal([3], shape);
        Assert.Equal("20", response.Nodes[2].FormattedValue);
    }

    [Fact]
    public void ExpandsByteArraysOnlyWhenExplicitlyAllowed()
    {
        using TemporaryFile file = new(BuildByteArrayPayload([1, 2, 255]));

        InspectResponse defaultResponse = Inspector.Inspect(file.Path);
        InspectResponse expandedResponse = Program.InspectArgs(
            ["--inspect", file.Path, "--expand-byte-arrays"]);

        Assert.Single(defaultResponse.Nodes);
        Assert.Contains(defaultResponse.Summary!.Warnings, warning => warning.Contains("byte配列"));
        Assert.Equal(["array", "scalar", "scalar", "scalar"],
            expandedResponse.Nodes.Select(node => node.Kind));
        Assert.Equal(["1", "2", "255"], expandedResponse.Nodes.Skip(1)
            .Select(node => node.FormattedValue));
    }

    [Fact]
    public void UsesTheFiveHundredThousandNodeLimit()
    {
        Assert.Equal(500_000, Inspector.MaximumNodes);
        Assert.Equal(256L * 1024 * 1024, Inspector.MaximumProtocolBytes);
    }

    [Fact]
    public void KeepsTheFiftyThousandElementLimitForExpandedByteArrays()
    {
        using TemporaryFile file = new(BuildByteArrayPayload(new byte[50_001]));

        InspectResponse response = Inspector.Inspect(file.Path, expandByteArrays: true);

        Assert.Equal(["array", "unsupported"], response.Nodes.Select(node => node.Kind));
        Assert.Contains("配列要素数上限", response.Nodes[1].FormattedValue);
    }

    [Fact]
    public void ReadsNestedClassMembersAndBreaksCyclesIntoReferences()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(12); // BinaryLibrary
        WriteInt32(payload, 10);
        WriteString(payload, "Sample.Assembly");
        payload.WriteByte(5); // ClassWithMembersAndTypes
        WriteInt32(payload, 1);
        WriteString(payload, "Sample.Person");
        WriteInt32(payload, 3);
        WriteString(payload, "<Name>k__BackingField");
        WriteString(payload, "Age");
        WriteString(payload, "Self");
        payload.Write([1, 0, 2]); // String, Primitive, Object
        payload.WriteByte(8); // Age = Int32
        WriteInt32(payload, 10); // library id
        payload.WriteByte(6); // BinaryObjectString
        WriteInt32(payload, 2);
        WriteString(payload, "Alice");
        WriteInt32(payload, 42);
        payload.WriteByte(9); // MemberReference
        WriteInt32(payload, 1);
        payload.WriteByte(11); // MessageEnd
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal(["object", "scalar", "scalar", "reference"], response.Nodes.Select(node => node.Kind));
        Assert.Equal("Name", response.Nodes[1].DisplayName);
        Assert.Equal("<Name>k__BackingField", response.Nodes[1].RawName);
        Assert.Equal("Alice", response.Nodes[1].FormattedValue);
        Assert.Equal(1, response.Nodes[3].ReferenceTargetId);
        Assert.Equal("1", response.Nodes[0].RecordId);
    }

    [Fact]
    public void ReadsNullAndSharedReferencesWithoutExpandingTheRecordTwice()
    {
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1, "Sample.Shared", ["First", "Second", "Missing"], [2, 2, 2]);
        payload.WriteByte(6); // BinaryObjectString
        WriteInt32(payload, 2);
        WriteString(payload, "shared");
        payload.WriteByte(9); // MemberReference
        WriteInt32(payload, 2);
        payload.WriteByte(10); // ObjectNull
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal(["object", "scalar", "reference", "null"], response.Nodes.Select(node => node.Kind));
        Assert.Equal(2, response.Nodes[2].ReferenceTargetId);
    }

    [Fact]
    public void ReadsListSerializationShapeForStrictUiPresentation()
    {
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1, "System.Collections.Generic.List`1[[System.String]]",
            ["_items", "_size", "_version"], [6, 0, 0], [8, 8]);
        payload.WriteByte(17); // ArraySingleString
        WriteInt32(payload, 2);
        WriteInt32(payload, 3);
        WriteObjectString(payload, 3, "a");
        WriteObjectString(payload, 4, "b");
        payload.WriteByte(10); // unused capacity = null
        WriteInt32(payload, 2);
        WriteInt32(payload, 1);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.StartsWith("System.Collections.Generic.List`1", response.Nodes[0].TypeName);
        Assert.Equal(["_items", "[0]", "[1]", "[2]", "_size", "_version"],
            response.Nodes.Skip(1).Select(node => node.RawName));
        Assert.Equal("null", response.Nodes[4].Kind);
    }

    [Fact]
    public void ReadsDictionarySerializationShapeForStrictUiPresentation()
    {
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1,
            "System.Collections.Generic.Dictionary`2[[System.String],[System.Int32]]",
            ["Version", "Comparer", "HashSize", "KeyValuePairs"], [0, 2, 0, 5], [8, 8]);
        WriteInt32(payload, 1);
        payload.WriteByte(10); // Comparer = null
        WriteInt32(payload, 1);
        payload.WriteByte(16); // ArraySingleObject
        WriteInt32(payload, 2);
        WriteInt32(payload, 1);
        WriteClassHeader(payload, 3, "System.Collections.Generic.KeyValuePair`2[[System.String],[System.Int32]]",
            ["key", "value"], [1, 0], [8]);
        WriteObjectString(payload, 4, "answer");
        WriteInt32(payload, 42);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Contains(response.Nodes, node => node.RawName == "KeyValuePairs" && node.Kind == "array");
        Assert.Contains(response.Nodes, node => node.RawName == "key" && node.FormattedValue == "answer");
        Assert.Contains(response.Nodes, node => node.RawName == "value" && node.FormattedValue == "42");
    }

    [Fact]
    public void ReadsJaggedArraysIteratively()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(16); // ArraySingleObject
        WriteInt32(payload, 1);
        WriteInt32(payload, 2);
        WriteInt32Array(payload, 2, [1, 2]);
        WriteInt32Array(payload, 3, [3]);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal(3, response.Nodes.Count(node => node.Kind == "array"));
        Assert.Equal(["1", "2", "3"], response.Nodes
            .Where(node => node.Kind == "scalar").Select(node => node.FormattedValue));
    }

    [Fact]
    public void ShowsOnlyTheShapeForMultidimensionalArrays()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(7); // BinaryArray
        WriteInt32(payload, 1);
        payload.WriteByte(2); // Rectangular
        WriteInt32(payload, 2);
        WriteInt32(payload, 2);
        WriteInt32(payload, 2);
        payload.WriteByte(0); // Primitive
        payload.WriteByte(8); // Int32
        foreach (int value in new[] { 1, 2, 3, 4 }) WriteInt32(payload, value);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal([2, 2], Assert.IsType<int[]>(response.Nodes[0].Shape));
        Assert.Single(response.Nodes);
        Assert.Contains(response.Summary!.Warnings, warning => warning.Contains("shape"));
    }

    [Fact]
    public void FormatsDateTimeTimeSpanAndDecimalInvariantly()
    {
        DateTime dateTime = new(2026, 9, 3, 12, 34, 56, DateTimeKind.Utc);
        using TemporaryFile dateFile = new(BuildPrimitiveArrayPayload(13, writer => writer.Write(dateTime.ToBinary())));
        using TemporaryFile timeFile = new(BuildPrimitiveArrayPayload(12, writer => writer.Write(TimeSpan.FromMinutes(90).Ticks)));
        using TemporaryFile decimalFile = new(BuildPrimitiveArrayPayload(5,
            writer => WriteString(writer.BaseStream, "1234.50")));

        Assert.Equal("2026-09-03T12:34:56.0000000Z", Inspector.Inspect(dateFile.Path).Nodes[1].FormattedValue);
        Assert.Equal("01:30:00", Inspector.Inspect(timeFile.Path).Nodes[1].FormattedValue);
        Assert.Equal("1234.50", Inspector.Inspect(decimalFile.Path).Nodes[1].FormattedValue);
    }

    [Fact]
    public void OmitsACompressedNullArrayAboveTheElementLimit()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(16); // ArraySingleObject
        WriteInt32(payload, 1);
        WriteInt32(payload, 50_001);
        payload.WriteByte(14); // ObjectNullMultiple
        WriteInt32(payload, 50_001);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Equal(["array", "unsupported"], response.Nodes.Select(node => node.Kind));
        Assert.Contains("配列要素数上限", response.Nodes[1].FormattedValue);
    }

    [Fact]
    public void OmitsScalarTextAboveOneMiB()
    {
        using TemporaryFile file = new(BuildStringPayload(new string('x', 1024 * 1024 + 1)));

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.Contains("1 MiB", response.Nodes[0].FormattedValue);
        Assert.NotEmpty(response.Summary!.Warnings);
    }

    [Fact]
    public void TruncatesUnicodeMemberNamesByUtf8Bytes()
    {
        string longName = new('名', 30_000);
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1, "Sample.LongName", [longName], [0], [8]);
        WriteInt32(payload, 1);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path);

        Assert.True(response.Ok);
        Assert.EndsWith("…", response.Nodes[1].RawName);
        Assert.True(Encoding.UTF8.GetByteCount(response.Nodes[1].RawName) <= 65_536);
    }

    [Fact]
    public void OmitsRemainingNodesBeforeJsonEscapingExceedsTheProtocolLimit()
    {
        const int memberCount = 11;
        string[] names = Enumerable.Range(0, memberCount).Select(index => $"f{index}").ToArray();
        byte[] binaryTypes = Enumerable.Repeat((byte)1, memberCount).ToArray();
        string escapedValue = new('\0', 1024 * 1024);
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1, "Sample.EscapedStrings", names, binaryTypes);
        for (int index = 0; index < memberCount; index++)
            WriteObjectString(payload, index + 20, escapedValue);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(
            file.Path, maximumProtocolBytes: 8L * 1024 * 1024);

        Assert.True(response.Ok);
        Assert.Contains(response.Nodes, node =>
            node.Kind == "unsupported" && node.FormattedValue?.Contains("プロトコル出力上限") == true);
        Assert.Contains(response.Summary!.Warnings, warning => warning.Contains("8 MiB"));
    }

    [Fact]
    public void ReservesTheFinalNodeForOmissionAtTheConfiguredNodeLimit()
    {
        const int maximumNodes = 100;
        const int memberCount = maximumNodes;
        string[] names = Enumerable.Range(0, memberCount).Select(index => $"f{index}").ToArray();
        byte[] binaryTypes = Enumerable.Repeat((byte)0, memberCount).ToArray();
        byte[] primitiveTypes = Enumerable.Repeat((byte)8, memberCount).ToArray();
        using MemoryStream payload = Header();
        WriteLibrary(payload);
        WriteClassHeader(payload, 1, "Sample.ManyMembers", names, binaryTypes, primitiveTypes);
        for (int index = 0; index < memberCount; index++) WriteInt32(payload, index);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Inspector.Inspect(file.Path, maximumNodes: maximumNodes);

        Assert.True(response.Ok);
        Assert.Equal(maximumNodes, response.Nodes.Count);
        Assert.Equal("unsupported", response.Nodes[^1].Kind);
        Assert.Contains("ノード数上限", response.Nodes[^1].FormattedValue);
        Assert.Contains(response.Summary!.Warnings, warning => warning.Contains("100"));
    }

    [Fact]
    public void ReportsUnsupportedOffsetArraysInJapanese()
    {
        using MemoryStream payload = Header();
        payload.WriteByte(7); // BinaryArray
        WriteInt32(payload, 1);
        payload.WriteByte(3); // SingleOffset
        WriteInt32(payload, 1);
        WriteInt32(payload, 1);
        WriteInt32(payload, 1); // non-zero lower bound
        payload.WriteByte(0);
        payload.WriteByte(8);
        WriteInt32(payload, 7);
        payload.WriteByte(11);
        using TemporaryFile file = new(payload.ToArray());

        InspectResponse response = Program.InspectArgs(["--inspect", file.Path]);

        Assert.False(response.Ok);
        Assert.Contains("対応していないNRBF形式", response.Error);
    }

    [Fact]
    public void RejectsAnInvalidHeaderInJapanese()
    {
        using TemporaryFile file = new([1, 2, 3, 4]);
        InspectResponse response = Inspector.Inspect(file.Path);
        Assert.False(response.Ok);
        Assert.Contains("ヘッダー", response.Error);
    }

    [Fact]
    public void RejectsFilesLargerThan64MiBBeforeDecoding()
    {
        string path = System.IO.Path.GetTempFileName();
        try
        {
            using (FileStream stream = File.OpenWrite(path)) stream.SetLength(64L * 1024 * 1024 + 1);
            InspectResponse response = Inspector.Inspect(path);
            Assert.False(response.Ok);
            Assert.Contains("64 MiB", response.Error);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static byte[] BuildStringPayload(string value)
    {
        using MemoryStream payload = Header();
        payload.WriteByte(6); // BinaryObjectString
        WriteInt32(payload, 1);
        byte[] text = Encoding.UTF8.GetBytes(value);
        Write7BitEncodedInt(payload, text.Length);
        payload.Write(text);
        payload.WriteByte(11); // MessageEnd
        return payload.ToArray();
    }

    private static byte[] BuildByteArrayPayload(byte[] values)
    {
        using MemoryStream payload = Header();
        payload.WriteByte(15); // ArraySinglePrimitive
        WriteInt32(payload, 1);
        WriteInt32(payload, values.Length);
        payload.WriteByte(2); // Byte
        payload.Write(values);
        payload.WriteByte(11);
        return payload.ToArray();
    }

    private static byte[] BuildPrimitiveArrayPayload(byte primitiveType, Action<BinaryWriter> writeValue)
    {
        using MemoryStream payload = Header();
        payload.WriteByte(15); // ArraySinglePrimitive
        WriteInt32(payload, 1);
        WriteInt32(payload, 1);
        payload.WriteByte(primitiveType);
        using (BinaryWriter writer = new(payload, Encoding.UTF8, leaveOpen: true)) writeValue(writer);
        payload.WriteByte(11);
        return payload.ToArray();
    }

    private static MemoryStream Header()
    {
        MemoryStream stream = new();
        stream.WriteByte(0); // SerializedStreamHeader
        WriteInt32(stream, 1); // root id
        WriteInt32(stream, -1); // header id
        WriteInt32(stream, 1); // major
        WriteInt32(stream, 0); // minor
        return stream;
    }

    private static void WriteInt32(Stream stream, int value) =>
        stream.Write(BitConverter.GetBytes(value));

    private static void WriteLibrary(Stream stream)
    {
        stream.WriteByte(12); // BinaryLibrary
        WriteInt32(stream, 10);
        WriteString(stream, "Sample.Assembly");
    }

    private static void WriteClassHeader(Stream stream, int id, string typeName,
        string[] memberNames, byte[] binaryTypes, byte[] primitiveTypes = null!)
    {
        stream.WriteByte(5); // ClassWithMembersAndTypes
        WriteInt32(stream, id);
        WriteString(stream, typeName);
        WriteInt32(stream, memberNames.Length);
        foreach (string name in memberNames) WriteString(stream, name);
        stream.Write(binaryTypes);
        int primitiveIndex = 0;
        foreach (byte binaryType in binaryTypes)
            if (binaryType == 0) stream.WriteByte(primitiveTypes[primitiveIndex++]);
        WriteInt32(stream, 10);
    }

    private static void WriteObjectString(Stream stream, int id, string value)
    {
        stream.WriteByte(6);
        WriteInt32(stream, id);
        WriteString(stream, value);
    }

    private static void WriteInt32Array(Stream stream, int id, int[] values)
    {
        stream.WriteByte(15);
        WriteInt32(stream, id);
        WriteInt32(stream, values.Length);
        stream.WriteByte(8);
        foreach (int value in values) WriteInt32(stream, value);
    }

    private static void Write7BitEncodedInt(Stream stream, int value)
    {
        uint remaining = (uint)value;
        while (remaining >= 0x80)
        {
            stream.WriteByte((byte)(remaining | 0x80));
            remaining >>= 7;
        }
        stream.WriteByte((byte)remaining);
    }

    private static void WriteString(Stream stream, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        Write7BitEncodedInt(stream, bytes.Length);
        stream.Write(bytes);
    }

    private sealed class TemporaryFile : IDisposable
    {
        internal TemporaryFile(byte[] bytes)
        {
            Path = System.IO.Path.GetTempFileName();
            File.WriteAllBytes(Path, bytes);
        }

        internal string Path { get; }

        public void Dispose() => File.Delete(Path);
    }
}
