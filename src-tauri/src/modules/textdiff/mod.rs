use crate::module::ModuleBackend;
pub struct TextDiffModule;
impl ModuleBackend for TextDiffModule {
    fn id(&self) -> &'static str {
        "textdiff"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
