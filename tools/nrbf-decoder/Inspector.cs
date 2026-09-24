using System.Collections;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Formats.Nrbf;
using System.Globalization;
using System.Runtime.Serialization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace MyMyTools.NrbfDecoder;

internal static class Inspector
{
    internal const long MaximumProtocolBytes = 256L * 1024 * 1024;
    internal const int MaximumNodes = 500_000;
    private const long MaximumInputBytes = 64L * 1024 * 1024;
    private const int MaximumArrayElements = 50_000;
    private const int MaximumScalarBytes = 1024 * 1024;
    private const long MaximumSearchTextBytes = 32L * 1024 * 1024;
    private static readonly TimeSpan MaximumDuration = TimeSpan.FromSeconds(55);

    internal static InspectResponse Inspect(
        string path,
        bool expandByteArrays = false,
        int maximumNodes = MaximumNodes,
        long maximumProtocolBytes = MaximumProtocolBytes,
        Action<string>? beforeExpandForTesting = null)
    {
        FileInfo file = new(path);
        if (!file.Exists) return InspectResponse.Failure("指定されたファイルがありません。");
        if (file.Length > MaximumInputBytes)
            return InspectResponse.Failure("ファイルサイズが64 MiBの上限を超えています。");

        Stopwatch stopwatch = Stopwatch.StartNew();
        using FileStream stream = file.OpenRead();
        if (!global::System.Formats.Nrbf.NrbfDecoder.StartsWithPayloadHeader(stream))
            return InspectResponse.Failure(Diagnostics.InvalidHeader(stream));

        SerializationRecord root;
        try
        {
            root = global::System.Formats.Nrbf.NrbfDecoder.Decode(
                stream, out _, Diagnostics.ApplicationOptions(), leaveOpen: true);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            long position = Diagnostics.SafePosition(stream);
            return InspectResponse.Failure(Diagnostics.DecodeFailure(file, exception, position, stopwatch));
        }
        List<string> payloadWarnings = [];
        List<SerializationRecord> roots = DecodeFollowingPayloads(stream, root, stopwatch, payloadWarnings);

        Builder builder = new(stopwatch, expandByteArrays, maximumNodes, maximumProtocolBytes,
            beforeExpandForTesting);
        foreach (string warning in payloadWarnings) builder.Warnings.Add(warning);
        builder.Build(roots);
        string? rootType = roots.Count == 1
            ? root.TypeName?.FullName
            : $"連結ペイロード ×{roots.Count.ToString("N0", CultureInfo.InvariantCulture)}（先頭: {root.TypeName?.FullName ?? "不明"}）";
        NrbfSummary summary = new(file.FullName, file.Name, file.Length, rootType,
            builder.Nodes.Count, builder.Warnings, stopwatch.ElapsedMilliseconds);
        return new(true, builder.Nodes, summary, null);
    }

    /// <summary>
    /// BinaryFormatterのSerializeを同じstreamへ繰り返したファイルは、header〜MessageEndの
    /// payloadが連続する。NrbfDecoderは最初のMessageEndで止まるため、残りを順に読み取る。
    /// 読めなくなった時点で打ち切り、解析済みpayloadは維持する。
    /// </summary>
    private static List<SerializationRecord> DecodeFollowingPayloads(FileStream stream,
        SerializationRecord first, Stopwatch stopwatch, List<string> warnings)
    {
        List<SerializationRecord> roots = [first];
        while (stream.Position < stream.Length)
        {
            long position = stream.Position;
            long remaining = stream.Length - position;
            if (roots.Count >= MaximumArrayElements)
            {
                warnings.Add($"連結されたペイロードが{MaximumArrayElements.ToString("N0", CultureInfo.InvariantCulture)}個を超えるため、"
                    + $"位置 {position.ToString("N0", CultureInfo.InvariantCulture)} 以降の {remaining.ToString("N0", CultureInfo.InvariantCulture)} バイトを省略しました。");
                break;
            }
            if (stopwatch.Elapsed > MaximumDuration)
            {
                warnings.Add($"解析時間が55秒を超えたため、位置 {position.ToString("N0", CultureInfo.InvariantCulture)} 以降のペイロードを省略しました。");
                break;
            }
            if (!global::System.Formats.Nrbf.NrbfDecoder.StartsWithPayloadHeader(stream))
            {
                warnings.Add($"{roots.Count.ToString("N0", CultureInfo.InvariantCulture)}個目のペイロードの後、位置 {position.ToString("N0", CultureInfo.InvariantCulture)} から "
                    + $"{remaining.ToString("N0", CultureInfo.InvariantCulture)} バイトのNRBFとして解釈できないデータがあります。");
                break;
            }
            try
            {
                roots.Add(global::System.Formats.Nrbf.NrbfDecoder.Decode(
                    stream, out _, Diagnostics.ApplicationOptions(), leaveOpen: true));
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                warnings.Add($"{(roots.Count + 1).ToString("N0", CultureInfo.InvariantCulture)}個目のペイロード（位置 {position.ToString("N0", CultureInfo.InvariantCulture)}）を解析できないため、"
                    + $"以降を省略しました: {Diagnostics.Describe(exception)}");
                break;
            }
        }
        if (roots.Count > 1)
        {
            warnings.Insert(0, $"BinaryFormatterのペイロードが{roots.Count.ToString("N0", CultureInfo.InvariantCulture)}個連結されていたため、"
                + $"それぞれを [0]〜[{(roots.Count - 1).ToString(CultureInfo.InvariantCulture)}] として表示しています。");
        }
        return roots;
    }

    private sealed class Builder(
        Stopwatch stopwatch,
        bool expandByteArrays,
        int maximumNodes,
        long maximumProtocolBytes,
        Action<string>? beforeExpandForTesting)
    {
        private const int MaximumExpansionFailureWarnings = 20;
        // record IDはpayloadごとに1から振られるため、payload番号と組にして正規nodeを引く。
        private readonly Dictionary<(int Payload, SerializationRecordId Id), int> _canonicalRecords = new();
        private readonly Stack<PendingValue> _pending = new();
        private long _searchTextBytes;
        private long _estimatedProtocolBytes;
        private bool _searchLimitWarned;
        private bool _nodeLimitWarned;
        private bool _protocolLimitWarned;
        private bool _stopExpansion;
        private int _expansionFailures;

        internal List<NrbfNode> Nodes { get; } = [];
        internal List<string> Warnings { get; } = [];

        internal void Build(IReadOnlyList<SerializationRecord> roots)
        {
            if (roots.Count == 1)
            {
                _pending.Push(new(roots[0], null, "$", "$"));
            }
            else
            {
                int containerId = AddNode(new(null, null, "$", "$"), "array", null, [roots.Count],
                    $"[{roots.Count.ToString(CultureInfo.InvariantCulture)} ペイロード]", null, null);
                for (int index = roots.Count - 1; index >= 0; index--)
                {
                    string name = $"[{index.ToString(CultureInfo.InvariantCulture)}]";
                    _pending.Push(new(roots[index], containerId, name, name, Payload: index));
                }
            }
            while (_pending.Count > 0 && !_stopExpansion)
            {
                if (stopwatch.Elapsed > MaximumDuration)
                {
                    AddWarning("解析時間が55秒を超えたため、残りのノードを省略しました。");
                    AddUnsupported(null, "省略", "省略", "解析時間上限");
                    break;
                }
                if (Nodes.Count >= maximumNodes - 1)
                {
                    if (!_nodeLimitWarned)
                    {
                        _nodeLimitWarned = true;
                        AddWarning($"ノード数が{maximumNodes.ToString("N0", CultureInfo.InvariantCulture)}件に達したため、残りを省略しました。");
                    }
                    PendingValue omitted = _pending.Pop();
                    _pending.Clear();
                    AddUnsupported(omitted.ParentId, "省略", "省略", "ノード数上限");
                    break;
                }
                ExpandOrReportFailure(_pending.Pop());
            }
            if (_expansionFailures > MaximumExpansionFailureWarnings)
            {
                AddWarning($"展開できなかった項目は合計{_expansionFailures.ToString("N0", CultureInfo.InvariantCulture)}件です。"
                    + $"警告には先頭{MaximumExpansionFailureWarnings}件だけを表示しています。");
            }
        }

        /// <summary>
        /// 1 recordの展開失敗で解析済みの木全体を捨てず、その項目だけを失敗nodeとwarningにする。
        /// </summary>
        private void ExpandOrReportFailure(PendingValue pending)
        {
            int nodesBefore = Nodes.Count;
            try
            {
                beforeExpandForTesting?.Invoke(pending.RawName);
                AddValue(pending);
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                _expansionFailures++;
                string path = DescribePath(pending);
                string type = pending.Value is SerializationRecord record
                    ? $"{record.RecordType} {TryFormatTypeName(record)}".TrimEnd()
                    : pending.Value?.GetType().FullName ?? "null";
                if (_expansionFailures <= MaximumExpansionFailureWarnings)
                    AddWarning($"{path}（{type}）を展開できませんでした: {Diagnostics.Describe(exception)}");
                // 親nodeだけ追加済みなら、その子として失敗理由を残す。
                int? parentId = Nodes.Count > nodesBefore ? nodesBefore + 1 : pending.ParentId;
                string name = Nodes.Count > nodesBefore ? "展開失敗" : pending.DisplayName;
                string rawName = Nodes.Count > nodesBefore ? "展開失敗" : pending.RawName;
                AddUnsupported(parentId, name, rawName,
                    $"展開失敗 ({exception.GetType().Name}: {Diagnostics.Limit(exception.Message, 200)})");
            }
        }

        private string DescribePath(PendingValue pending)
        {
            List<string> segments = [pending.RawName];
            for (int? parentId = pending.ParentId; parentId is int id && segments.Count < 64;
                parentId = Nodes[id - 1].ParentId)
            {
                segments.Add(Nodes[id - 1].RawName);
            }
            segments.Reverse();
            StringBuilder path = new();
            foreach (string segment in segments)
            {
                if (path.Length > 0 && !segment.StartsWith('[')) path.Append('.');
                path.Append(segment);
            }
            return Diagnostics.Limit(path.ToString(), 300);
        }

        private static string TryFormatTypeName(SerializationRecord record)
        {
            try
            {
                return record.TypeName?.FullName ?? string.Empty;
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                return string.Empty;
            }
        }

        private void AddValue(PendingValue pending)
        {
            if (pending.OmittedReason is not null)
            {
                AddUnsupported(pending.ParentId, pending.DisplayName, pending.RawName, pending.OmittedReason);
                return;
            }
            if (pending.Value is null)
            {
                AddNode(pending, "null", null, null, "null", null, null);
                return;
            }
            if (pending.Value is not SerializationRecord record)
            {
                AddScalar(pending, pending.Value, null);
                return;
            }

            SerializationRecordId recordId = record.Id;
            if (_canonicalRecords.TryGetValue((pending.Payload, recordId), out int targetNodeId))
            {
                AddNode(pending, "reference", record, null, $"→ #{targetNodeId}", targetNodeId, null);
                return;
            }
            if (record is PrimitiveTypeRecord primitive)
            {
                int id = AddScalar(pending, primitive.Value, record);
                _canonicalRecords[(pending.Payload, recordId)] = id;
                return;
            }
            if (record is ClassRecord classRecord)
            {
                int id = AddNode(pending, "object", record, null, null, null, null);
                _canonicalRecords[(pending.Payload, recordId)] = id;
                if (_stopExpansion) return;
                string[] memberNames = classRecord.MemberNames.ToArray();
                for (int index = memberNames.Length - 1; index >= 0; index--)
                {
                    string rawName = memberNames[index];
                    _pending.Push(new(GetMemberValue(classRecord, rawName), id, FriendlyName(rawName), rawName,
                        Payload: pending.Payload));
                }
                return;
            }
            if (record is ArrayRecord arrayRecord)
            {
                AddArray(pending, arrayRecord);
                return;
            }

            int unsupportedId = AddNode(pending, "unsupported", record, null,
                $"非対応レコード: {record.RecordType}", null, null);
            _canonicalRecords[(pending.Payload, recordId)] = unsupportedId;
        }

        private void AddArray(PendingValue pending, ArrayRecord record)
        {
            int[] shape = record.Lengths.ToArray();
            long elementCount = 1;
            foreach (int length in shape)
            {
                if (length < 0 || elementCount > MaximumArrayElements / Math.Max(length, 1))
                {
                    elementCount = MaximumArrayElements + 1L;
                    break;
                }
                elementCount *= length;
            }

            int id = AddNode(pending, "array", record, shape,
                $"[{string.Join(" × ", shape)}]", null, null);
            _canonicalRecords[(pending.Payload, record.Id)] = id;
            if (_stopExpansion) return;

            if (elementCount > MaximumArrayElements)
            {
                AddWarning($"配列 {pending.RawName} は50,000要素を超えるため、内容を省略しました。");
                _pending.Push(new(null, id, "省略", "省略", "配列要素数上限", pending.Payload));
                return;
            }
            if (record is SZArrayRecord<byte> && !expandByteArrays)
            {
                AddWarning($"byte配列 {pending.RawName} は安全のため内容を展開せず、長さだけ表示します。");
                return;
            }
            if (record.Rank != 1)
            {
                AddWarning($"多次元配列 {pending.RawName} はshapeのみ表示します。");
                return;
            }
            if (!TryReadArray(record, out IReadOnlyList<object?> values))
            {
                AddWarning($"配列 {pending.RawName} の要素型は安全に展開できないため、Raw情報だけ表示します。");
                return;
            }
            for (int index = values.Count - 1; index >= 0; index--)
            {
                string name = $"[{index}]";
                _pending.Push(new(values[index], id, name, name, Payload: pending.Payload));
            }
        }

        private static bool TryReadArray(ArrayRecord record, out IReadOnlyList<object?> values)
        {
            IEnumerable? source = record switch
            {
                SZArrayRecord<bool> value => value.GetArray(true),
                SZArrayRecord<byte> value => value.GetArray(true),
                SZArrayRecord<sbyte> value => value.GetArray(true),
                SZArrayRecord<char> value => value.GetArray(true),
                SZArrayRecord<short> value => value.GetArray(true),
                SZArrayRecord<ushort> value => value.GetArray(true),
                SZArrayRecord<int> value => value.GetArray(true),
                SZArrayRecord<uint> value => value.GetArray(true),
                SZArrayRecord<long> value => value.GetArray(true),
                SZArrayRecord<ulong> value => value.GetArray(true),
                SZArrayRecord<float> value => value.GetArray(true),
                SZArrayRecord<double> value => value.GetArray(true),
                SZArrayRecord<decimal> value => value.GetArray(true),
                SZArrayRecord<DateTime> value => value.GetArray(true),
                SZArrayRecord<TimeSpan> value => value.GetArray(true),
                SZArrayRecord<string> value => value.GetArray(true),
                SZArrayRecord<ClassRecord> value => value.GetArray(true),
                SZArrayRecord<SerializationRecord> value => value.GetArray(true),
                _ => null,
            };
            source ??= TryReadBuiltInReferenceArray(record);
            if (source is null)
            {
                values = [];
                return false;
            }
            values = source.Cast<object?>().ToArray();
            return true;
        }

        [UnconditionalSuppressMessage("Aot", "IL3050",
            Justification = "呼び出し型はNativeAOTでrootされるstring[]とobject[]の定数だけに限定する。")]
        private static IEnumerable? TryReadBuiltInReferenceArray(ArrayRecord record)
        {
            foreach (Type expectedType in new[] { typeof(string[]), typeof(object[]) })
            {
                try
                {
                    return record.GetArray(expectedType, allowNulls: true);
                }
                catch (InvalidOperationException)
                {
                    // payload由来の型は生成せず、安全な組み込み配列型だけを順に試す。
                }
            }
            return null;
        }

        private int AddScalar(PendingValue pending, object value, SerializationRecord? record)
        {
            string formatted = FormatScalar(value);
            if (Encoding.UTF8.GetByteCount(formatted) > MaximumScalarBytes)
            {
                formatted = "（1 MiBを超える値のため省略）";
                AddWarning($"スカラー値 {pending.RawName} は1 MiBを超えるため省略しました。");
            }
            return AddNode(pending, "scalar", record, null, formatted, null, value.GetType().FullName);
        }

        private int AddNode(PendingValue pending, string kind, SerializationRecord? record,
            int[]? shape, string? formattedValue, int? referenceTargetId, string? fallbackTypeName)
        {
            int id = Nodes.Count + 1;
            string displayName = LimitText(pending.DisplayName, 65_536);
            string rawName = LimitText(pending.RawName, 65_536);
            string? typeName = record?.TypeName?.FullName ?? fallbackTypeName;
            string? assemblyName = record?.TypeName?.AssemblyName?.FullName;
            long searchBytes = Encoding.UTF8.GetByteCount(displayName) + Encoding.UTF8.GetByteCount(rawName)
                + (formattedValue is null ? 0 : Encoding.UTF8.GetByteCount(formattedValue));
            if (_searchTextBytes + searchBytes > MaximumSearchTextBytes)
            {
                if (!_searchLimitWarned)
                {
                    _searchLimitWarned = true;
                    AddWarning("検索対象文字列が32 MiBに達したため、残りのノードを省略しました。");
                }
                displayName = "省略";
                rawName = "省略";
                kind = "unsupported";
                typeName = null;
                assemblyName = null;
                formattedValue = "省略: 検索文字列上限";
                referenceTargetId = null;
                shape = null;
                record = null;
                searchBytes = 0;
                _pending.Clear();
                _stopExpansion = true;
            }
            else _searchTextBytes += searchBytes;

            long nodeProtocolBytes = 256
                + JsonEncodedByteCount(displayName)
                + JsonEncodedByteCount(rawName)
                + JsonEncodedByteCount(kind)
                + JsonEncodedByteCount(typeName)
                + JsonEncodedByteCount(assemblyName)
                + JsonEncodedByteCount(formattedValue);
            if (_estimatedProtocolBytes + nodeProtocolBytes > maximumProtocolBytes - 1024 * 1024)
            {
                if (!_protocolLimitWarned)
                {
                    _protocolLimitWarned = true;
                    AddWarning($"プロトコル出力が{maximumProtocolBytes / 1024 / 1024} MiBに近づいたため、残りを省略しました。");
                }
                displayName = "省略";
                rawName = "省略";
                kind = "unsupported";
                typeName = null;
                assemblyName = null;
                formattedValue = "省略: プロトコル出力上限";
                referenceTargetId = null;
                shape = null;
                record = null;
                nodeProtocolBytes = 512;
                _pending.Clear();
                _stopExpansion = true;
            }
            _estimatedProtocolBytes += nodeProtocolBytes;
            Nodes.Add(new(id, pending.ParentId, displayName, rawName, kind, typeName, assemblyName,
                formattedValue, record is null ? null : FormatRecordId(record.Id), referenceTargetId, shape));
            return id;
        }

        private static int JsonEncodedByteCount(string? value) =>
            value is null ? 0 : JsonEncodedText.Encode(value).EncodedUtf8Bytes.Length;

        private void AddUnsupported(int? parentId, string displayName, string rawName, string reason) =>
            AddNode(new(null, parentId, displayName, rawName), "unsupported", null, null,
                $"省略: {reason}", null, null);

        private void AddWarning(string warning)
        {
            if (!Warnings.Contains(warning, StringComparer.Ordinal)) Warnings.Add(warning);
        }

        internal static string FriendlyName(string rawName)
        {
            const string suffix = ">k__BackingField";
            return rawName.StartsWith('<') && rawName.EndsWith(suffix, StringComparison.Ordinal)
                ? rawName[1..^suffix.Length] : rawName;
        }

        private static object? GetMemberValue(ClassRecord record, string memberName)
        {
            try
            {
                return record.GetSerializationRecord(memberName);
            }
            catch (InvalidOperationException)
            {
                return record.GetRawValue(memberName);
            }
        }

        private static string FormatRecordId(SerializationRecordId id)
        {
            // 10.0.11の公開型は数値getterを持たない。固定済みpackageの単一Int32表現を
            // そのまま表示し、参照判定自体は公開Equals契約で行う。
            ReadOnlySpan<SerializationRecordId> ids = MemoryMarshal.CreateReadOnlySpan(ref id, 1);
            int value = MemoryMarshal.Read<int>(MemoryMarshal.AsBytes(ids));
            return value.ToString(CultureInfo.InvariantCulture);
        }

        private static string LimitText(string value, int maximumBytes)
        {
            if (Encoding.UTF8.GetByteCount(value) <= maximumBytes) return value;
            int low = 0;
            int high = value.Length;
            int payloadLimit = maximumBytes - Encoding.UTF8.GetByteCount("…");
            while (low < high)
            {
                int middle = low + (high - low + 1) / 2;
                if (Encoding.UTF8.GetByteCount(value.AsSpan(0, middle)) <= payloadLimit) low = middle;
                else high = middle - 1;
            }
            int characters = low;
            return string.Concat(value.AsSpan(0, characters), "…");
        }

        private static string FormatScalar(object value) => value switch
        {
            string text => text,
            char character => character.ToString(),
            bool boolean => boolean ? "true" : "false",
            DateTime dateTime => dateTime.ToString("O", CultureInfo.InvariantCulture),
            TimeSpan timeSpan => timeSpan.ToString("c", CultureInfo.InvariantCulture),
            decimal decimalValue => decimalValue.ToString(CultureInfo.InvariantCulture),
            float floatValue => floatValue.ToString("R", CultureInfo.InvariantCulture),
            double doubleValue => doubleValue.ToString("R", CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? string.Empty,
        };
    }

    private sealed record PendingValue(object? Value, int? ParentId, string DisplayName,
        string RawName, string? OmittedReason = null, int Payload = 0);
}
