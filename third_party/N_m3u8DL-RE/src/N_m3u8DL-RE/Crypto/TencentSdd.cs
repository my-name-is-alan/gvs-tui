using System.Buffers.Binary;

namespace N_m3u8DL_RE.Crypto;

// Confirmed profile: outer V3, inner METHOD=0E9CA2BAE3E3CCC9,
// txdid=A584C2CB45653B85, HEVC Annex B in 188-byte MPEG-TS packets.
internal static class TencentSdd
{
    private const int PacketSize = 188;
    private sealed class Pes
    {
        internal readonly MemoryStream Raw = new();
        internal readonly MemoryStream Decoded = new();
        internal readonly List<int> Slots = [];
        internal byte[] Header = [];
        internal int End;
    }

    internal static byte[] Decrypt(byte[] encrypted, byte[] material, byte[] outerNonce)
    {
        // Fixed profile in the method name; do not guess unverified selectors.
        // custom key = outer key (32) || SDD key (32) || SDD nonce (12).
        if (material.Length != 76 || outerNonce.Length != 12)
            throw new InvalidDataException("Tencent V3+SDD requires 76-byte material and a 12-byte outer nonce");
        var ts = TencentChaChaV3.Crypt(encrypted, material[..32], outerNonce);
        return RestoreTransport(ts, material[32..64], material[64..76]);
    }

    private static int Pid(ReadOnlySpan<byte> packet) => ((packet[1] & 31) << 8) | packet[2];
    private static int PayloadOffset(ReadOnlySpan<byte> packet)
    {
        if (packet.Length != PacketSize || packet[0] != 0x47 || (packet[1] & 0x80) != 0 || (packet[3] & 0xc0) != 0)
            throw new InvalidDataException("Invalid Tencent SDD transport packet");
        int control = (packet[3] >> 4) & 3;
        if (control == 0) throw new InvalidDataException("Invalid TS adaptation control");
        int offset = (control & 2) != 0 ? 5 + packet[4] : 4;
        if (offset > PacketSize || ((control & 1) != 0 && offset == PacketSize))
            throw new InvalidDataException("Invalid TS adaptation length");
        return (control & 1) != 0 ? offset : PacketSize;
    }

    // Reassemble PSI sections, including tables crossing TS packet boundaries.
    private static List<byte[]> Sections(byte[] ts, int pid, Action<byte[],int[]>? capture = null)
    {
        var sections = new List<byte[]>();
        var pending = new List<byte>();
        var positions = new List<int>();
        void Feed(ReadOnlySpan<byte> bytes, int absolute)
        {
            for (int index = 0; index < bytes.Length; index++)
            {
                byte value = bytes[index];
                if (pending.Count == 0 && value == 0xff) break;
                pending.Add(value);
                positions.Add(absolute + index);
                if (pending.Count < 3) continue;
                int length = 3 + ((pending[1] & 15) << 8) + pending[2];
                if (length < 8 || length > 4096) throw new InvalidDataException("Invalid SDD PSI section");
                if (pending.Count == length)
                {
                    var section = pending.ToArray();
                    sections.Add(section); capture?.Invoke(section,positions.ToArray());
                    pending.Clear(); positions.Clear();
                }
            }
        }
        for (int i = 0; i < ts.Length; i += PacketSize)
        {
            var p = ts.AsSpan(i, PacketSize);
            if (Pid(p) != pid) continue;
            int off = PayloadOffset(p);
            if (off == PacketSize) continue;
            if ((p[1] & 0x40) != 0)
            {
                int pointer = p[off++];
                if (off + pointer > PacketSize) throw new InvalidDataException("Invalid SDD PSI pointer");
                if (pending.Count > 0) Feed(p.Slice(off, pointer),i+off);
                pending.Clear(); positions.Clear(); off += pointer;
            }
            Feed(p[off..],i+off);
        }
        return sections;
    }

    private static int VideoPid(byte[] ts)
    {
        var pmts = new HashSet<int>();
        foreach (var s in Sections(ts, 0).Where(s => s[0] == 0))
            for (int i = 8; i + 4 <= s.Length - 4; i += 4)
                if (s[i] != 0 || s[i+1] != 0) pmts.Add(((s[i+2] & 31) << 8) | s[i+3]);
        var video = new HashSet<int>();
        bool audioOnly = true, hasAudio = false;
        var pmtSections = new List<(byte[] Data,int[] Positions)>();
        var changed = new HashSet<byte[]>();
        foreach (int pid in pmts)
            foreach (var s in Sections(ts, pid, (s,positions) => pmtSections.Add((s,positions))).Where(s => s[0] == 2))
            {
                if (s.Length < 16) throw new InvalidDataException("Invalid SDD PMT");
                for (int i = 12 + ((s[10] & 15) << 8) + s[11]; i + 5 <= s.Length - 4;)
                {
                    int next = i + 5 + ((s[i+3] & 15) << 8) + s[i+4];
                    if (next > s.Length - 4) throw new InvalidDataException("Invalid SDD PMT descriptor");
                    bool privateHevc = false;
                    for (int d = i+5; d+2 <= next;)
                    {
                        int end = d+2+s[d+1];
                        if (end > next) throw new InvalidDataException("Invalid SDD stream descriptor");
                        // Confirmed encrypted HEVC PMT marker on Tencent TS.
                        if (s[d] == 0x0f && s[d+1] == 4 && s.AsSpan(d+2,4).SequenceEqual("tvf2"u8)) privateHevc = true;
                        d = end;
                    }
                    if (s[i] == 0x24 || (s[i] == 0xc0 && privateHevc)) video.Add(((s[i+1] & 31) << 8) | s[i+2]);
                    if (s[i] == 0xc0 && privateHevc)
                    {
                        s[i] = 0x24; changed.Add(s); // standard HEVC for downstream MKV demuxers
                    }
                    if (s[i] is 0x0f or 0x11 or 0x81 or 0x87) hasAudio = true;
                    else audioOnly = false;
                    i = next;
                }
            }
        if (video.Count == 0 && hasAudio && audioOnly) return -1;
        if (video.Count != 1) throw new InvalidDataException("Tencent SDD requires exactly one HEVC video PID");
        foreach (var (data,positions) in pmtSections.Where(p => changed.Contains(p.Data)))
        {
            uint crc = uint.MaxValue;
            foreach (byte value in data.AsSpan(0,data.Length-4))
            {
                crc ^= (uint)value << 24;
                for (int bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) != 0 ? 0x04c11db7u : 0);
            }
            BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(data.Length-4),crc);
            for (int i = 0; i < data.Length; i++) ts[positions[i]] = data[i];
        }
        return video.Single();
    }

    internal static byte[] RestoreTransport(byte[] ts, byte[] key, byte[] nonce)
    {
        if (key.Length != 32 || nonce.Length != 12 || ts.Length == 0 || ts.Length > 128 * 1024 * 1024 || ts.Length % PacketSize != 0)
            throw new InvalidDataException("Invalid Tencent SDD segment or material");
        for (int i = 0; i < ts.Length; i += PacketSize) PayloadOffset(ts.AsSpan(i,PacketSize));
        int videoPid = VideoPid(ts);
        if (videoPid == -1) return ts; // separate audio has outer encryption only
        var packets = new List<Pes>(); Pes? current = null;
        for (int i = 0; i < ts.Length; i += PacketSize)
        {
            var p = ts.AsSpan(i, PacketSize);
            if (Pid(p) != videoPid) continue;
            int off = PayloadOffset(p);
            if (off == PacketSize) continue;
            if ((p[1] & 0x40) != 0) { current = new Pes(); packets.Add(current); }
            if (current == null) throw new InvalidDataException("SDD segment begins with an incomplete video PES");
            current.Slots.Add(i);
            current.Raw.Write(p[off..]);
        }
        using var elementary = new MemoryStream();
        foreach (var pes in packets)
        {
            var b = pes.Raw.ToArray();
            if (b.Length < 9 || b[0] != 0 || b[1] != 0 || b[2] != 1 || b[3] < 0xe0 || b[3] > 0xef || (b[6] & 0xc0) != 0x80)
                throw new InvalidDataException("Invalid SDD video PES");
            int h = 9 + b[8], length = BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(4));
            if (h > b.Length || (length != 0 && length + 6 != b.Length)) throw new InvalidDataException("Incomplete SDD video PES");
            pes.Header = b[..h]; elementary.Write(b.AsSpan(h)); pes.End = (int)elementary.Length;
        }
        if (packets.Count == 0) throw new InvalidDataException("SDD video PES missing");
        int owner = 0;
        // Map every restored byte to its source PES. This also handles a NAL or
        // its emulation-prevention bytes straddling multiple PES packets.
        RestoreAnnexB(elementary.ToArray(), key, nonce, (position, value) =>
        {
            while (owner + 1 < packets.Count && position >= packets[owner].End) owner++;
            packets[owner].Decoded.WriteByte(value);
        });
        var replacements = new Dictionary<int, List<byte[]>>();
        bool first = true;
        foreach (var pes in packets)
        {
            var body = pes.Header.Concat(pes.Decoded.ToArray()).ToArray();
            if (BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(4)) != 0)
            {
                if (body.Length - 6 > ushort.MaxValue) throw new InvalidDataException("SDD PES too large");
                BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(4), (ushort)(body.Length - 6));
            }
            int pos = 0;
            foreach (int slot in pes.Slots)
            {
                var original = ts.AsSpan(slot, PacketSize);
                byte[] adaptation = (original[3] & 0x20) != 0 ? original.Slice(5, original[4]).ToArray() : [];
                if (first)
                {
                    if (adaptation.Length == 0) adaptation = [0];
                    adaptation[0] |= 0x80; // payload packet count can change independently per HLS segment
                    first = false;
                }
                int take = Math.Min(184 - (adaptation.Length > 0 ? adaptation.Length + 1 : 0), body.Length - pos);
                replacements[slot] = [MakePacket(original, body.AsSpan(pos,take), adaptation, pos == 0)];
                pos += take;
            }
            while (pos < body.Length)
            {
                int take = Math.Min(184, body.Length - pos);
                int last = pes.Slots[^1];
                replacements[last].Add(MakePacket(ts.AsSpan(last,PacketSize), body.AsSpan(pos,take), [], false));
                pos += take;
            }
        }
        using var result = new MemoryStream();
        int? continuity = null;
        for (int i = 0; i < ts.Length; i += PacketSize)
        {
            if (Pid(ts.AsSpan(i,PacketSize)) != videoPid) { result.Write(ts.AsSpan(i,PacketSize)); continue; }
            var group = replacements.TryGetValue(i, out var replacement) ? replacement : [ts.AsSpan(i,PacketSize).ToArray()];
            foreach (var p in group)
            {
                bool hasPayload = (p[3] & 0x10) != 0;
                continuity ??= (p[3] & 15) - (hasPayload ? 1 : 0);
                if (hasPayload) continuity = (continuity + 1) & 15;
                p[3] = (byte)((p[3] & 0xf0) | (continuity.Value & 15));
                result.Write(p);
            }
        }
        return result.ToArray();
    }

    private static byte[] MakePacket(ReadOnlySpan<byte> original, ReadOnlySpan<byte> payload, byte[] adaptation, bool start)
    {
        byte[] p = new byte[PacketSize]; Array.Fill(p, (byte)0xff);
        original[..4].CopyTo(p);
        p[1] = (byte)((p[1] & ~0x40) | (start && payload.Length > 0 ? 0x40 : 0));
        int padding = 184 - payload.Length;
        if (padding == 0) p[3] = (byte)((p[3] & 15) | 0x10);
        else
        {
            p[3] = (byte)((p[3] & 15) | (payload.Length > 0 ? 0x30 : 0x20));
            p[4] = (byte)(padding - 1);
            if (padding > 1) { p[5] = 0; adaptation.CopyTo(p,5); }
        }
        payload.CopyTo(p.AsSpan(PacketSize - payload.Length));
        return p;
    }

    internal static void RestoreAnnexB(byte[] data, byte[] key, byte[] nonce, Action<int,byte> emit)
    {
        var starts = new List<(int Start,int Body)>();
        for (int i = 0; i + 3 <= data.Length; i++)
        {
            if (data[i] != 0 || data[i+1] != 0) continue;
            int prefix = data[i+2] == 1 ? 3 : i+3 < data.Length && data[i+2] == 0 && data[i+3] == 1 ? 4 : 0;
            if (prefix == 0) continue;
            starts.Add((i,i+prefix)); i += prefix - 1;
        }
        if (starts.Count == 0 || starts[0].Start != 0) throw new InvalidDataException("SDD HEVC Annex B start code missing");
        for (int index = 0; index < starts.Count; index++)
        {
            var (start, body) = starts[index]; int end = index+1 < starts.Count ? starts[index+1].Start : data.Length;
            if (end - body < 2) throw new InvalidDataException("Truncated SDD HEVC NAL");
            int type = (data[body] >> 1) & 63;
            bool selected = type <= 5 || type is 19 or 20 or 21;
            for (int i = start; i < (selected ? body : end); i++) emit(i,data[i]);
            if (!selected) continue;
            var nal = new List<byte>(); var positions = new List<int>();
            for (int i = body; i < end; i++)
            {
                if (i+3 < end && data[i] == 0 && data[i+1] == 0 && data[i+2] == 3 && data[i+3] <= 3)
                {
                    nal.Add(0); positions.Add(i++); nal.Add(0); positions.Add(i++); // omit ciphertext escape byte
                }
                else { nal.Add(data[i]); positions.Add(i); }
            }
            var bytes = nal.ToArray();
            for (int off = 48; off <= bytes.Length - 64; off += 192)
                TencentChaChaV2.Crypt(bytes.AsSpan(off,64), key, nonce, (ulong)off);
            // Already the original EBSP: escaping again causes silent pixel damage.
            for (int i = 0; i < bytes.Length; i++) emit(positions[i],bytes[i]);
        }
    }
}
