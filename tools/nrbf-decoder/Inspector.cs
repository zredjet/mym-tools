using System.Collections;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Formats.Nrbf;
using System.Globalization;
using System.Runtime.Serialization;
using System.Runtime.InteropServices;
using System.Text;

namespace MyMyTools.NrbfDecoder;

internal static class Inspector
{
    internal const long MaximumProtocolBytes = 64L * 1024 * 1024;
    private const long MaximumInputBytes = 64L * 1024 * 1024;
    private const int MaximumNodes = 100_000;
    private const int MaximumArrayElements = 50_000;
    private const int MaximumScalarBytes = 1024 * 1024;
    private const long MaximumSearchTextBytes = 32L * 1024 * 1024;
    private static readonly TimeSpan MaximumDuration = TimeSpan.FromSeconds(55);

    internal static InspectResponse Inspect(string path)
    {
        FileInfo file = new(path);
        if (!file.Exists) return InspectResponse.Failure("指定されたファイルがありません。");
        if (file.Length > MaximumInputBytes)
            return InspectResponse.Failure("ファイルサイズが64 MiBの上限を超えています。");

        Stopwatch stopwatch = Stopwatch.StartNew();
        using FileStream stream = file.OpenRead();
        if (!global::System.Formats.Nrbf.NrbfDecoder.StartsWithPayloadHeader(stream))
            return InspectResponse.Failure("BinaryFormatter NRBFのヘッダーではありません。");

        SerializationRecord root = global::System.Formats.Nrbf.NrbfDecoder.Decode(
            stream, out _, new PayloadOptions { UndoTruncatedTypeNames = false }, leaveOpen: false);
        Builder builder = new(stopwatch);
        builder.Build(root);
        NrbfSummary summary = new(file.FullName, file.Name, file.Length, root.TypeName?.FullName,
            builder.Nodes.Count, builder.Warnings, stopwatch.ElapsedMilliseconds);
        return new(true, builder.Nodes, summary, null);
    }

    private sealed class Builder(Stopwatch stopwatch)
    {
        private readonly Dictionary<SerializationRecordId, int> _canonicalRecords = new();
        private readonly Stack<PendingValue> _pending = new();
        private long _searchTextBytes;
        private long _estimatedProtocolBytes;
        private bool _searchLimitWarned;
        private bool _nodeLimitWarned;
        private bool _protocolLimitWarned;
        private bool _stopExpansion;

        internal List<NrbfNode> Nodes { get; } = [];
        internal List<string> Warnings { get; } = [];

        internal void Build(SerializationRecord root)
        {
            _pending.Push(new(root, null, "$", "$"));
            while (_pending.Count > 0 && !_stopExpansion)
            {
                if (stopwatch.Elapsed > MaximumDuration)
                {
                    AddWarning("解析時間が55秒を超えたため、残りのノードを省略しました。");
                    AddUnsupported(null, "省略", "省略", "解析時間上限");
                    break;
                }
                if (Nodes.Count >= MaximumNodes - 1)
                {
                    if (!_nodeLimitWarned)
                    {
                        _nodeLimitWarned = true;
                        AddWarning("ノード数が100,000件に達したため、残りを省略しました。");
                    }
                    PendingValue omitted = _pending.Pop();
                    _pending.Clear();
                    AddUnsupported(omitted.ParentId, "省略", "省略", "ノード数上限");
                    break;
                }
                AddValue(_pending.Pop());
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
            if (_canonicalRecords.TryGetValue(recordId, out int targetNodeId))
            {
                AddNode(pending, "reference", record, null, $"→ #{targetNodeId}", targetNodeId, null);
                return;
            }
            if (record is PrimitiveTypeRecord primitive)
            {
                int id = AddScalar(pending, primitive.Value, record);
                _canonicalRecords[recordId] = id;
                return;
            }
            if (record is ClassRecord classRecord)
            {
                int id = AddNode(pending, "object", record, null, null, null, null);
                _canonicalRecords[recordId] = id;
                if (_stopExpansion) return;
                string[] memberNames = classRecord.MemberNames.ToArray();
                for (int index = memberNames.Length - 1; index >= 0; index--)
                {
                    string rawName = memberNames[index];
                    _pending.Push(new(GetMemberValue(classRecord, rawName), id, FriendlyName(rawName), rawName));
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
            _canonicalRecords[recordId] = unsupportedId;
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
            _canonicalRecords[record.Id] = id;
            if (_stopExpansion) return;

            if (elementCount > MaximumArrayElements)
            {
                AddWarning($"配列 {pending.RawName} は50,000要素を超えるため、内容を省略しました。");
                _pending.Push(new(null, id, "省略", "省略", "配列要素数上限"));
                return;
            }
            if (record is SZArrayRecord<byte>)
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
                _pending.Push(new(values[index], id, name, name));
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

            long nodeProtocolBytes = 256 + searchBytes
                + (typeName is null ? 0 : Encoding.UTF8.GetByteCount(typeName))
                + (assemblyName is null ? 0 : Encoding.UTF8.GetByteCount(assemblyName));
            if (_estimatedProtocolBytes + nodeProtocolBytes > MaximumProtocolBytes - 1024 * 1024)
            {
                if (!_protocolLimitWarned)
                {
                    _protocolLimitWarned = true;
                    AddWarning("プロトコル出力が64 MiBに近づいたため、残りを省略しました。");
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
        string RawName, string? OmittedReason = null);
}
